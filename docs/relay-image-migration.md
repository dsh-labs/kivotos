# Relay image: moved to the `dsh-labs` org

The project moved to `github.com/dsh-labs/kivotos`, and the relay server's
container image publishes under that organisation from now on:

|                    |                                  |
| ------------------ | -------------------------------- |
| **New** (use this) | `ghcr.io/dsh-labs/kivotos-relay` |
| Old (frozen)       | `ghcr.io/rinai-r/kivotos-relay`  |

- Tag scheme is unchanged: `latest` and every `v<version>` tag come from the
  same workflow as before; only the registry namespace changed. `main` and
  `sha-<short>` continue to be pushed from `main` too.
- The old package is **not** deleted and is **never pushed to again**. It keeps
  the last version built before the move; it will not receive security fixes or
  new releases.
- `packages/relay/docker-compose.yml` (and the copy the READMEs tell a server to
  download) already points at the new image, so a fresh install is unaffected.

## Switching an existing install

In your `docker-compose.yml`, change:

```yaml
services:
  relay:
    image: ghcr.io/dsh-labs/kivotos-relay:latest
```

then `docker compose pull && docker compose up -d`. The `/data` volume, the
network registrations and the published port are unchanged; only the image
reference moves. A pinned version can be pulled directly:

```sh
docker pull ghcr.io/dsh-labs/kivotos-relay:0.6.1
```
