package expo.modules.kivotosattention

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.util.Locale

/**
 * System notifications for attention frames. Channels are high importance,
 * so Android shows them as heads-up pop-ups over other apps.
 */
object Notifier {
  const val CHANNEL_ATTENTION = "attention"
  const val CHANNEL_RESULTS = "results"
  const val CHANNEL_SERVICE = "service"
  /** Live Updates: not MIN (Android never promotes a MIN channel's notification), and silent. */
  const val CHANNEL_LIVE = "live"
  const val EXTRA_MACHINE = "kivotos.machine"
  const val EXTRA_SESSION = "kivotos.session"
  /** The approval ask a notification's buttons decide (#notification-approval). */
  const val EXTRA_APPROVAL = "kivotos.approval"
  const val EXTRA_DECISION = "kivotos.decision"
  const val EXTRA_KEY = "kivotos.key"
  const val ACTION_APPROVE = "kivotos.APPROVE"
  /** Logo blue (#3478DB), the accent of expanded notifications. */
  private const val BRAND_BLUE = 0xFF3478DB.toInt()
  /** The Live Update's tap: one request code, its extras replaced with each update. */
  private const val LIVE_REQUEST = 7381

  private val zh: Boolean get() = Locale.getDefault().language == "zh"

  fun text(en: String, zhText: String) = if (zh) zhText else en

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ATTENTION,
        text("Approvals and questions", "审批与提问"),
        NotificationManager.IMPORTANCE_HIGH,
      ).apply { description = text("A session is waiting for you", "会话正在等你处理") },
    )
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_RESULTS,
        text("Finished tasks", "任务完成"),
        NotificationManager.IMPORTANCE_HIGH,
      ).apply { description = text("A session finished or failed", "会话已完成或失败") },
    )
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_SERVICE,
        text("Connection", "连接"),
        NotificationManager.IMPORTANCE_MIN,
      ).apply {
        description = text("Keeps Kivotos connected to your machines", "保持 Kivotos 与各机器的连接")
        setShowBadge(false)
      },
    )
    // Only where Live Updates can exist: older Android keeps its channel list as it was.
    if (Build.VERSION.SDK_INT < 36) return
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_LIVE,
        text("Live updates", "实时活动"),
        NotificationManager.IMPORTANCE_DEFAULT,
      ).apply {
        description = text("What your machines are doing, in the status bar", "各台机器正在做什么，显示在状态栏")
        setSound(null, null)
        enableVibration(false)
        setShowBadge(false)
      },
    )
  }

  /** The ongoing notification the foreground service must show. */
  fun serviceNotification(context: Context, connected: Int, total: Int) =
    NotificationCompat.Builder(context, CHANNEL_SERVICE)
      .setSmallIcon(R.drawable.kivotos_notification)
      .setContentTitle(text("Watching $connected of $total machines", "正在关注 $connected/$total 台机器"))
      .setContentIntent(openIntent(context, null, null, 0))
      .setOngoing(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .build()

  /**
   * The service's ongoing notification as a Live Update (Android 16 QPR1+,
   * see [LiveUpdates]): the chip says what waits ("待确认") or how long the
   * earliest turn has run, the card names the machine and session. The lock
   * screen gets a version without names.
   */
  @RequiresApi(36)
  fun liveNotification(context: Context, live: LiveUpdates.Content): Notification {
    val title = if (live.title.isEmpty()) live.machineName else "${live.machineName} · ${live.title}"
    val status = when (live.kind) {
      LiveUpdates.Kind.APPROVAL -> text("Waiting for your approval", "等你确认")
      LiveUpdates.Kind.QUESTION -> text("Waiting for your answer", "等你回答")
      LiveUpdates.Kind.RUNNING -> text("Running", "正在运行")
      LiveUpdates.Kind.FINISHED -> text("Finished", "已完成")
      LiveUpdates.Kind.FAILED -> text("Failed", "失败")
    }
    val body = if (live.machines > 1) "$status · " + text("${live.machines} machines", "${live.machines} 台机器") else status
    val chip = when (live.kind) {
      LiveUpdates.Kind.APPROVAL -> text("Approve", "待确认")
      LiveUpdates.Kind.QUESTION -> text("Answer", "待回答")
      // The chip shows the chronometer instead.
      LiveUpdates.Kind.RUNNING -> null
      LiveUpdates.Kind.FINISHED -> text("Done", "完成")
      LiveUpdates.Kind.FAILED -> text("Failed", "失败")
    }
    fun builder(title: String) = Notification.Builder(context, CHANNEL_LIVE)
      .setSmallIcon(R.drawable.kivotos_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(Notification.BigTextStyle().bigText(body))
      .setColor(BRAND_BLUE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(if (live.kind == LiveUpdates.Kind.RUNNING) Notification.CATEGORY_PROGRESS else Notification.CATEGORY_STATUS)
      .apply {
        if (chip != null) setShortCriticalText(chip)
        if (live.kind == LiveUpdates.Kind.RUNNING) {
          // A start the computer's clock puts ahead of the phone's would count down.
          setWhen(minOf(live.since, System.currentTimeMillis())).setShowWhen(true).setUsesChronometer(true)
        } else {
          setShowWhen(false)
        }
      }
      .addExtras(Bundle().apply { putBoolean(LiveUpdates.EXTRA_REQUEST_PROMOTED, true) })
    return builder(title)
      .setContentIntent(openIntent(context, live.machineId, live.sessionId, LIVE_REQUEST))
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setPublicVersion(builder("Kivotos").build())
      .build()
  }

  /**
   * Post (or replace) the notification for one frame.
   *
   * Buttons are added only when the frame carries an approvable ask: one held
   * for the phone that maps to an exact tool call. Anything else stays a
   * reminder and is answered in the session's page.
   */
  fun post(context: Context, machine: Machine, frame: AttentionFrame) {
    if (!canPost(context)) return
    val title = frame.title.ifEmpty { text("Session", "会话") }
    val (channel, headline) = when (frame.kind) {
      "approval" -> CHANNEL_ATTENTION to text("Approval needed", "需要审批")
      "question" -> CHANNEL_ATTENTION to text("Question for you", "有问题等你回答")
      "done" -> CHANNEL_RESULTS to text("Task finished", "任务完成")
      "failed" -> CHANNEL_RESULTS to text("Task failed", "任务失败")
      else -> return
    }
    val id = notificationId(machine.id, frame.sessionId, frame.key)
    val builder = NotificationCompat.Builder(context, channel)
      .setSmallIcon(R.drawable.kivotos_notification)
      .setContentTitle("$headline · $title")
      .setContentText(frame.detail.ifEmpty { machine.name })
      .setSubText(machine.name)
      .setStyle(NotificationCompat.BigTextStyle().bigText(frame.detail.ifEmpty { machine.name }))
      .setContentIntent(openIntent(context, machine.id, frame.sessionId, id))
      .setAutoCancel(true)
      .setColor(BRAND_BLUE)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setDefaults(NotificationCompat.DEFAULT_ALL)
      .setCategory(
        if (channel == CHANNEL_ATTENTION) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS,
      )
      .setGroup("kivotos.${machine.id}.${frame.sessionId}")
    val approval = frame.approval
    if (approval != null && frame.kind == "approval") {
      val base = "$machine.id|${frame.sessionId}|${frame.key}|${approval.token}"
      builder.addAction(
        0,
        text("Deny", "拒绝"),
        approvalIntent(context, base, 1, machine.id, frame.sessionId, frame.key, approval.token, "deny"),
      )
      builder.addAction(
        0,
        text("Allow once", "允许本次"),
        approvalIntent(context, base, 2, machine.id, frame.sessionId, frame.key, approval.token, "allow"),
      )
    }
    @Suppress("MissingPermission")
    NotificationManagerCompat.from(context).notify(id, builder.build())
  }

  /** Withdraw the approval/question notification a `resolved` frame settles. */
  fun cancel(context: Context, machineId: String, sessionId: String, key: String) {
    NotificationManagerCompat.from(context).cancel(notificationId(machineId, sessionId, key))
  }

  /** Withdraw every notification of a session the user has just opened. */
  fun cancelSession(context: Context, machineId: String, sessionId: String) {
    val manager = context.getSystemService(NotificationManager::class.java)
    val group = "kivotos.$machineId.$sessionId"
    manager.activeNotifications.filter { it.notification.group == group }.forEach { manager.cancel(it.id) }
  }

  private fun canPost(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED

  /** A broadcast the app turns into one decision through the machine's door. */
  private fun approvalIntent(
    context: Context,
    base: String,
    slot: Int,
    machineId: String,
    sessionId: String,
    key: String,
    token: String,
    decision: String,
  ): PendingIntent {
    val intent = Intent(context, ApprovalReceiver::class.java).apply {
      action = ACTION_APPROVE
      putExtra(EXTRA_MACHINE, machineId)
      putExtra(EXTRA_SESSION, sessionId)
      putExtra(EXTRA_KEY, key)
      putExtra(EXTRA_APPROVAL, token)
      putExtra(EXTRA_DECISION, decision)
    }
    // One request code per ask and button: two asks never share an intent.
    return PendingIntent.getBroadcast(
      context,
      "$base|$slot".hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun notificationId(machineId: String, sessionId: String, key: String) =
    "$machineId|$sessionId|$key".hashCode()

  fun openIntent(context: Context, machineId: String?, sessionId: String?, requestCode: Int): PendingIntent {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: Intent().setPackage(context.packageName)
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (machineId != null && sessionId != null) {
      launch.putExtra(EXTRA_MACHINE, machineId).putExtra(EXTRA_SESSION, sessionId)
    }
    return PendingIntent.getActivity(
      context,
      requestCode,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }
}
