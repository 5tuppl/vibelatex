# VibeLaTeX Web Docker Deployment

The web app should run as a long-lived container. It needs WebSocket support,
`latexmk`, TeX Live packages, and a persistent writable `/app/workspace`
volume for projects and generated PDFs.

## Local Docker Run

```bash
docker compose up --build
```

Open:

```text
http://localhost:3000
```

Health check:

```bash
curl http://localhost:3000/healthz
```

Stop the app:

```bash
docker compose down
```

Keep project data by leaving the `vibelatex-workspace` volume in place. Remove
it only when you intentionally want to delete all container-managed projects:

```bash
docker compose down --volumes
```

## Image Build

```bash
docker build -t vibelatex:local .
```

Run without Compose:

```bash
docker run --rm \
  -p 3000:3000 \
  -v vibelatex-workspace:/app/workspace \
  vibelatex:local
```

## Production Shape

Recommended baseline:

- Build the Docker image in CI.
- Push the image to a registry such as GHCR, Docker Hub, or a private registry.
- Deploy the image to a VPS or container platform with a persistent volume
  mounted at `/app/workspace`.
- Put a reverse proxy in front of the app for HTTPS.
- Add authentication before exposing the app on the public internet.
- Ensure the proxy supports WebSocket upgrades for Socket.IO.
- Ensure browsers can reach the CDN-hosted CodeMirror and PDF.js assets, or
  vendor those frontend assets before deploying to an offline network.
- Keep the container as a single replica unless project state is moved to shared
  storage and active-project state is redesigned.

Avoid serverless deployments for this app. The app performs local filesystem
writes, runs `latexmk`, serves generated PDFs, and uses WebSockets.

## VPS Pipeline

One practical pipeline:

1. CI builds and pushes an image tagged with the commit SHA and `latest`.
2. The server pulls the new image.
3. The server runs `docker compose up -d`.
4. A persistent Docker volume or host directory remains mounted at
   `/app/workspace`.
5. A reverse proxy such as Caddy, Nginx, or Traefik terminates TLS and forwards
   traffic to port `3000`.

For a host-directory mount, use:

```yaml
volumes:
  - /srv/vibelatex/workspace:/app/workspace
```

Make sure the directory is writable by the container user.

## Security Notes

The current web app is designed as a single-user or trusted-team tool. It has no
application login, and active project/compiler state is shared process-wide.
Before public exposure, put Basic Auth, SSO, or app-level authentication in
front of it.

LaTeX compilation is also an execution boundary. The Compose file runs the app
as a non-root container user, drops Linux capabilities, prevents privilege
escalation, limits process count/memory, and mounts a private `/tmp`. Do not
mount sensitive host paths into `/app/workspace`.

## QA Checklist

Run these before deploying a new image:

```bash
node --check server.js
docker build -t vibelatex:qa .
docker run --rm -d --name vibelatex-qa -p 3000:3000 vibelatex:qa
curl http://localhost:3000/healthz
docker logs vibelatex-qa
docker rm -f vibelatex-qa
```

After deployment:

- Open the web app.
- Open the demo project.
- Trigger compile.
- Confirm `build/main.pdf` renders in the preview.
- Introduce a LaTeX error and confirm the console shows a line-specific error.
- Fix the error and confirm the PDF refreshes.
