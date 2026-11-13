package expo.modules.kivotosattention

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.SystemClock

/**
 * Android 16 Live Updates: what the machines are doing, folded from their
 * attention streams into one promoted notification (the status-bar chip,
 * the card at the top of the shade and on the lock screen).
 *
 * Each machine has a [Board]: its Sessions that run a turn, wait for an
 * approval or an answer, or finished a moment ago. [content] reduces all
 * boards to what the notification shows, waiting before running before
 * finished. The service renders it in place of its own ongoing notification
 * ([AttentionService]), so there is one notification and one icon; where
 * Android cannot promote it ([state]), nothing changes.
 */
object LiveUpdates {
  /** How long a finished turn stays in the live update. */
  const val FINISHED_MS = 15_000L

  /** How long a machine's state outlives a dropped stream before it counts as unknown. */
  const val STALE_MS = 30_000L

  /** Least time between two updates of the notification. */
  const val THROTTLE_MS = 600L

  /** The extra that asks for promotion (`Notification.EXTRA_REQUEST_PROMOTED_ONGOING`, API 36.1). */
  const val EXTRA_REQUEST_PROMOTED = "android.requestPromotedOngoing"

  enum class Kind { APPROVAL, QUESTION, RUNNING, FINISHED, FAILED }

  /** Whether Live Updates can show: the switch's state in the app. */
  enum class State {
    /** On, and Android promotes the app's notifications. */
    ON,
    /** Turned off with the app's switch. */
    OFF,
    /** Android has no Live Updates (before Android 16 QPR1). */
    UNSUPPORTED,
    /** Android supports them but does not allow this app (its promotion setting). */
    BLOCKED,
  }

  /** What the notification shows; equal content is not sent again. */
  data class Content(
    val kind: Kind,
    val machineId: String,
    val sessionId: String,
    val machineName: String,
    /** The session's title, "" when no frame named one. */
    val title: String,
    /** For [Kind.RUNNING], when the earliest running turn started (the computer's clock). */
    val since: Long,
    /**
     * For [Kind.RUNNING], whole minutes it has run: the chip's text. Android
     * 16's status-bar chip shows no chronometer for an ongoing notification
     * (observed on the 36.1 image: only the icon-less clock), so the chip
     * carries the elapsed time as text, updated each minute.
     */
    val minutes: Long,
    /** Machines with something to show. */
    val machines: Int,
  )

  private class Board {
    /** Running turns: session id to start time. */
    val running = HashMap<String, Long>()
    /** Open waits by `session\nkey`, oldest first. */
    val waits = LinkedHashMap<String, Pair<Kind, String>>()
    /** Finished turns by session: whether it failed, and when it arrived (elapsed realtime). */
    val finished = HashMap<String, Pair<Boolean, Long>>()
    val titles = HashMap<String, String>()
    /** Elapsed realtime the stream dropped at; null while it is connected. */
    var droppedAt: Long? = null
  }

  private val boards = HashMap<String, Board>()
  /** Boards a reconnecting stream rebuilds from its replay, swapped in at `live`. */
  private val replays = HashMap<String, Board>()
  private val names = HashMap<String, String>()

  /** Called (on any thread) when the content may have changed; the service re-renders. */
  @Volatile var onChange: (() -> Unit)? = null

  /**
   * @return whether the app may show a Live Update now: the switch is on and
   *   Android 16 QPR1+ allows this app's promoted notifications.
   */
  fun state(context: Context): State {
    if (Build.VERSION.SDK_INT < 36) return State.UNSUPPORTED
    val manager = context.getSystemService(NotificationManager::class.java)
    val allowed = try {
      manager.canPostPromotedNotifications()
    } catch (_: NoSuchMethodError) {
      // Android 16 before QPR1: the method is not there.
      return State.UNSUPPORTED
    }
    if (!allowed) return State.BLOCKED
    return if (AttentionState.liveEnabled(context)) State.ON else State.OFF
  }

  /** A stream connected: its replay rebuilds the machine's board. */
  @Synchronized fun connected(machine: Machine) {
    names[machine.id] = machine.name
    replays[machine.id] = Board()
  }

  /** The replay ended (`event: live`): it is the machine's state now. */
  @Synchronized fun live(machineId: String) {
    val replay = replays.remove(machineId) ?: return
    // Finished turns are news only once; a replay never raises them again.
    boards[machineId]?.finished?.let { replay.finished.putAll(it) }
    boards[machineId] = replay
    changed()
  }

  /** The stream dropped: what it said stays until [STALE_MS] has passed without a new one. */
  @Synchronized fun dropped(machineId: String) {
    replays.remove(machineId)
    boards[machineId]?.droppedAt = SystemClock.elapsedRealtime()
    changed()
  }

  /** Keep only the machines the app follows. */
  @Synchronized fun retain(machines: Collection<Machine>) {
    val ids = machines.map { it.id }.toSet()
    machines.forEach { names[it.id] = it.name }
    boards.keys.retainAll(ids)
    replays.keys.retainAll(ids)
    changed()
  }

  /** The user is looking at this session: its finished turn is seen. */
  @Synchronized fun seen(machineId: String, sessionId: String) {
    if (boards[machineId]?.finished?.remove(sessionId) != null) changed()
  }

  /**
   * Fold one frame.
   * @param news - not seen before (a replayed frame the phone already had is not).
   */
  @Synchronized fun fold(machine: Machine, frame: AttentionFrame, news: Boolean) {
    names[machine.id] = machine.name
    val replay = replays[machine.id]
    val board = replay ?: boards.getOrPut(machine.id) { Board() }
    val session = frame.sessionId
    if (frame.title.isNotEmpty()) board.titles[session] = frame.title
    val wait = "$session\n${frame.key}"
    when (frame.kind) {
      "running" -> {
        board.running[session] = frame.time
        board.finished.remove(session)
      }
      "idle" -> board.running.remove(session)
      "approval" -> board.waits[wait] = Kind.APPROVAL to session
      "question" -> board.waits[wait] = Kind.QUESTION to session
      "resolved" -> board.waits.remove(wait)
      "done", "failed" -> {
        board.running.remove(session)
        if (news && !AttentionState.isOnScreen(machine.id, session)) {
          board.finished[session] = (frame.kind == "failed") to SystemClock.elapsedRealtime()
        }
      }
      else -> return
    }
    if (replay == null) changed()
  }

  /** @return what to show now, or null for nothing. */
  @Synchronized fun content(): Content? {
    val now = SystemClock.elapsedRealtime()
    val active = boards.filterValues { board ->
      board.finished.values.removeAll { (_, at) -> now - at >= FINISHED_MS }
      val fresh = board.droppedAt.let { it == null || now - it < STALE_MS }
      fresh && (board.waits.isNotEmpty() || board.running.isNotEmpty() || board.finished.isNotEmpty())
    }
    if (active.isEmpty()) return null
    fun make(kind: Kind, machineId: String, session: String, since: Long) = Content(
      kind = kind,
      machineId = machineId,
      sessionId = session,
      machineName = names[machineId] ?: machineId,
      title = active.getValue(machineId).titles[session].orEmpty(),
      since = since,
      minutes = if (kind == Kind.RUNNING) (System.currentTimeMillis() - since).coerceAtLeast(0) / 60_000 else 0,
      machines = active.size,
    )
    // The oldest wait: one per machine is its first, so take the first machine that has one.
    for ((id, board) in active) {
      val (kind, session) = board.waits.values.firstOrNull() ?: continue
      return make(kind, id, session, 0)
    }
    active.flatMap { (id, board) -> board.running.map { (session, since) -> Triple(id, session, since) } }
      .minByOrNull { it.third }
      ?.let { (id, session, since) -> return make(Kind.RUNNING, id, session, since) }
    val (id, entry) = active.flatMap { (id, board) -> board.finished.map { id to it } }
      .maxBy { it.second.value.second }
    return make(if (entry.value.first) Kind.FAILED else Kind.FINISHED, id, entry.key, 0)
  }

  /** @return elapsed realtime of the next expiry (a finished turn, a dropped stream), or null. */
  @Synchronized fun nextExpiry(): Long? {
    val now = SystemClock.elapsedRealtime()
    val times = boards.values.flatMap { board ->
      board.finished.values.map { it.second + FINISHED_MS } + listOfNotNull(board.droppedAt?.plus(STALE_MS))
    }
    // A running turn's chip counts minutes: the next whole minute of the earliest one.
    val earliest = boards.values.flatMap { it.running.values }.minOrNull()
    val minute = earliest?.let {
      now + 60_000 - (System.currentTimeMillis() - it).coerceAtLeast(0) % 60_000
    }
    // A stream that dropped long ago has expired already: nothing to wait for.
    return (times + listOfNotNull(minute)).filter { it > now }.minOrNull()
  }

  /** Render again: the content, the app's switch or Android's promotion setting may have changed. */
  fun changed() {
    onChange?.invoke()
  }
}
