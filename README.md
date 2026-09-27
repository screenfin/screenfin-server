# screenfin-server

Watch parties for Jellyfin, self-hosted beside your own server.

The official container runs the Screenfin relay and the compiled browser application together on
one port. Media never passes through it: every Screenfin client authenticates with and streams
directly from Jellyfin. The relay carries room membership, play, pause, seek, and synchronization.

Source-available under [PolyForm Shield 1.0.0](LICENSE): free to run, modify, and self-host, but
not to build a competing product.

## Install

You need Docker and a running Jellyfin server. Save this as `compose.yaml`:

```yaml
services:
  screenfin-server:
    image: ghcr.io/screenfin/screenfin-server:latest
    container_name: screenfin-server
    restart: unless-stopped
    ports:
      # Plain HTTP for a reverse proxy on this host, so loopback only.
      - '127.0.0.1:8484:8484'
    environment:
      # How the container reaches Jellyfin. Never localhost: that is the container itself.
      JELLYFIN_URL: http://192.168.1.10:8096
      # The address people open Screenfin at.
      ALLOWED_ORIGINS: https://screenfin.example.com
      # The same address as a WebSocket: wss:// behind TLS, ws:// without, ending in /v1/ws.
      ADVERTISED_URLS: wss://screenfin.example.com/v1/ws
      # Your reverse proxy's address as the container sees it. Required behind a proxy:
      # see "Behind a reverse proxy" below.
      TRUST_PROXY: 172.18.0.1
    volumes:
      - relay-data:/data

volumes:
  relay-data:
```

On a plain LAN with no reverse proxy, publish `'8484:8484'`, drop `TRUST_PROXY`, and use the
host's own address instead, for example `http://192.168.1.20:8484` and
`ws://192.168.1.20:8484/v1/ws`. Then start it:

```sh
docker compose up -d
```

Every other setting has a default. [`.env.example`](.env.example) lists them; add any you need
under `environment:` and run `docker compose up -d` again.

### Pair it with Jellyfin

On first start the relay creates its identity key, and every start it prints a **branding mark**
that names it. Print just that line with:

```sh
docker logs screenfin-server 2>&1 | grep '^/\* screenfin' | tail -1
```

```text
/* screenfin {"schema":1,"jellyfinServerId":"…","relays":[{"relayId":"…","publicKey":"…","urls":[…]}]} */
```

In the full log (`docker logs screenfin-server`) the same line sits in a banner headed
**SCREENFIN BRANDING MARK**.

As a Jellyfin administrator, open **Dashboard → General → Branding → Custom CSS**, paste the whole
`/* screenfin … */` line at the bottom, below anything already written there, and save. Every
Screenfin client signed in to that Jellyfin can now find the relay, and checks its key before
trusting it with anything.

The key lives in the `relay-data` volume, so keep that volume. If it is deleted
(`docker compose down -v`) or left behind when you move hosts, the relay prints a new mark and
clients refuse to connect until you paste it in place of the old one.

### Behind a reverse proxy

The proxy must forward WebSocket upgrades on `/v1/ws` and must not close idle connections early; a
proxy that drops either serves the page but leaves parties unable to connect.

`TRUST_PROXY` must name the proxy. Without it every client arrives as the proxy's one address, and
the relay's per-address limits on new connections become a single bucket that one anonymous client
can empty for everybody. A proxy on the same host, reaching the loopback port, arrives from the
Docker network's gateway:

```sh
docker network inspect "$(docker inspect screenfin-server -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')" \
  -f '{{(index .IPAM.Config 0).Gateway}}'
```

Trust that gateway only while the port is published on `127.0.0.1`: once it is open to the LAN, a
direct client can arrive from the same address. A proxy container on a Docker network shared with
this one uses its own address, or that network's subnet. Numeric hop counts are rejected, and
`true` trusts anyone; use neither.

## Update

```sh
docker compose pull
docker compose up -d
```

## Troubleshooting

```sh
curl http://127.0.0.1:8484/healthz             # on the host
curl https://screenfin.example.com/healthz     # through the proxy
docker logs screenfin-server
```

- The local check passes and the public one fails: the reverse-proxy route is wrong.
- The page loads but parties do not connect: the proxy is not forwarding WebSocket upgrades on
  `/v1/ws`, or is closing idle connections.
- `AUTH_UNAVAILABLE` in the logs: the container cannot reach `JELLYFIN_URL`.
- A browser origin refusal: the address bar does not exactly match `ALLOWED_ORIGINS`, scheme
  included.

## Development

`docker build -f Dockerfile.relay .` builds the relay from this source, without the web app the
official image carries. The wire protocol is in [protocol/PROTOCOL.md](protocol/PROTOCOL.md).

Issues are welcome. This repository is generated from Screenfin's release source, so pull requests
are not merged here.
