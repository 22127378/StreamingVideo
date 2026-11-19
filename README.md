# StreamForge

A video streaming platform on AWS EKS. Personal project, June to August 2026.

Users upload a video, a worker transcodes it into adaptive bitrate HLS with FFmpeg, and players stream it through CloudFront. Users can also go live from OBS through Amazon IVS, with channel subscriptions and live chat. Transcode workers scale on queue depth and run on Spot, premium videos are protected with CloudFront signed cookies, and no pod holds long-lived AWS keys. The EKS control plane and NAT gateway alone cost roughly $105 a month while the cluster exists, so the cluster is meant to be created for demos and destroyed afterwards.

## Current state

StreamForge is split into microservices. Each one has its own image, Argo Rollout, IAM role and, where it stores data, its own database schema and user. Services never read each other's tables: they talk through events on an EventBridge bus, plus one internal HTTP call from playback to catalog.

| Service | Public routes | Does | Owns |
| --- | --- | --- | --- |
| `src/account-service` | `/api/auth/*` | Sign-in config, current user, upgrade to Premium | Cognito groups |
| `src/upload-service` | `/api/uploads/*` | Presigned S3 upload URL, confirm upload | schema `upload` |
| `src/catalog-service` | `/api/videos/*` | List, detail, my videos, ratings, views, delete; builds its data from events | schema `catalog` |
| `src/playback-service` | `/api/playback/*` | Access check, CloudFront signed cookies, view events | nothing (stateless) |
| `src/live-service` | `/api/live/*` | Live channels on Amazon IVS, stream keys for OBS, subscriptions, live chat | schema `live` |
| `src/transcode-worker` | none | FFmpeg to HLS (KEDA ScaledJob on Spot) | nothing |

`src/shared` holds the code they share (HTTP setup, token checks, logging, metrics, database pool, migrations, events). `src/frontend` is the React app. Monitoring runs on the cluster (Prometheus, Loki, Alloy, Grafana, `k8s/monitoring/`), and ArgoCD syncs the cluster from a separate config repository, [StreamingVideo-config](https://github.com/22127378/StreamingVideo-config).

Events (source `streamforge.<service>`):

```
upload    --VideoCreated------------------------------> catalog   (video shows as UPLOADING)
upload    --VideoUploaded--+--(detail only)-----------> transcode queue -> worker
                           +--------------------------> catalog   (PROCESSING)
worker    --TranscodeStarted/Completed/Failed---------> catalog   (READY / FAILED)
playback  --VideoViewed-------------------------------> catalog   (view count)
```

The catalog applies events idempotently (it records event ids) and only when the current status allows it, because SQS does not keep order. Events for a deleted video are dropped, and HLS files a worker writes after a delete are removed.

Not built yet: a custom domain, and ALB weighted target groups for canaries (canary traffic is split by pod count).

## Running locally

Requirements: Docker. Node.js 22 or newer to run tests outside Docker.

```bash
docker compose --profile app up -d --build
```

This starts LocalStack (S3, SQS, EventBridge with the same rules as AWS), PostgreSQL, the three migration jobs, the five services, the worker, MediaMTX (stands in for Amazon IVS: RTMP in on port 1935, HLS out on port 8888) and an nginx gateway on http://localhost:4000 that routes `/api/*` like the ALB does. Then run the frontend with `cd src/frontend && npm install && npm run dev` (http://localhost:5173). Without Cognito, sign in with any email and pick a tier.

Tests per package: `npm test` in `src/shared`, `src/*-service` and `src/transcode-worker`. The upload, catalog and live suites also run against PostgreSQL with `DB_TEST=1` (see the comment at the top of each test file). After changing `src/shared`, run `npm install` in the services: they install it as a copy (`install-links=true`).

Test scenarios for the deployed stack (functional, security, resilience and k6 load tests) are in `docs/test-plan.md`, with scripts under `tests/`.

## Architecture

```
                         Browser
                            │ HTTPS
                            ▼
   CloudFront ── /            → S3 web (React app)
              ── /videos/*    → S3 processed (HLS), signed cookie required
              ── /api/*       → ALB (open to CloudFront only)
                                 │
          ┌──────────────┬───────┴──────┬────────────────┬───────────────┐
          ▼              ▼              ▼                ▼               ▼
   /api/auth        /api/uploads    /api/videos     /api/playback    /api/live
   account          upload          catalog ◀────── playback         live (schema live)
   (Cognito)        (schema upload) (schema catalog)  internal HTTP  manages IVS channels
                        │               ▲
                        │ events        │ events (SQS catalog-events)
                        ▼               │
                 ┌───────── EventBridge bus ─────────┐
                 │ VideoUploaded (detail) → SQS transcode → worker (KEDA ScaledJob, Spot)
                 │ all streamforge.* events → catalog │
                 └────────────────────────────────────┘
   Aurora PostgreSQL Serverless v2: one cluster, one schema and one IAM-auth user per service

   OBS ──RTMPS──▶ Amazon IVS ──HLS (IVS CDN)──▶ Browser    live video never passes through the cluster
```

Editable diagrams of both the local flow and the AWS design are in `docs/architecture.drawio` (open it at app.diagrams.net or with the Draw.io VS Code extension).

In the cloud design, an S3 upload event reaches SQS through EventBridge. Locally there is no EventBridge, so the API sends the SQS message itself when the client calls `POST /api/videos/complete`.

## Tech stack

| Layer | Technology |
| --- | --- |
| Container orchestration | AWS EKS |
| Infrastructure | Terraform (6 modules, 12 layers) |
| Networking | VPC, CloudFront, ALB |
| Storage | S3 for video assets and Terraform state, Aurora PostgreSQL Serverless v2 |
| Messaging | EventBridge, SQS, DLQ |
| Transcoding | FFmpeg on Spot instances |
| Live streaming | Amazon IVS (MediaMTX locally), chat over PostgreSQL |
| Autoscaling | KEDA ScaledJob (scale to zero) plus a placeholder pod against cold starts |
| GitOps | ArgoCD App-of-Apps with a separate config repo |
| CI/CD | GitHub Actions with GitHub OIDC, Argo Rollouts canary with Prometheus analysis |
| Monitoring and scanning | Prometheus, Loki, Alloy, Grafana, CloudWatch alarms, Trivy, Checkov |
| Security | Cognito, IRSA, IAM database auth, CloudFront signed cookies, KMS |

## Infrastructure

Terraform lives in `terraform/`, split into layers that are applied separately. See `terraform/README.md` for the apply order and how to run the services locally against real AWS.

| Layer | Status | Contents |
| --- | --- | --- |
| backend | Built | State bucket (versioned, KMS-encrypted, TLS only), AWS Budget alarm |
| cicd | Built | GitHub OIDC provider and the CI role that pushes images to ECR (main branch only). Applied once, kept across teardowns |
| storage | Built | Raw and processed S3 buckets. The old DynamoDB `videos` table is still here until it is removed |
| messaging | Built | Transcode SQS queue and DLQ |
| identity | Built | IAM policies for the worker (and the old API's dev roles, to be removed) |
| networking | Built | VPC across 2 AZs, public and private subnets, one NAT gateway |
| compute | Built | EKS Auto Mode, ECR (one repository per service), IRSA roles for the worker and KEDA, ALB security group open to CloudFront only |
| delivery | Built | CloudFront: frontend bucket, HLS from the processed bucket via OAC behind a signed-cookie key group, `/api/*` and `/grafana*` to the ALB |
| auth | Built | Cognito user pool, app client and the `premium` and `admin` groups |
| database | Built | Aurora PostgreSQL 17 Serverless v2 (pauses after 10 idle minutes), master secret in Secrets Manager |
| services | Built | EventBridge bus and rules, catalog event queue and DLQ, one IRSA role per service (live: IVS channels), database connect rights per service user |
| observability | Built | SNS alert topic, Loki bucket, IRSA roles for Loki, Alertmanager and Grafana, CloudWatch alarms on the DLQ, stuck queue and CloudFront 5xx |

The app runs on EKS from `k8s/`: NodePools for an on-demand API pool and a Spot transcode pool, KEDA running the worker as a ScaledJob (one Job per video, scaled to zero, with a placeholder pod keeping a warm node to avoid cold starts), migration Jobs for the database, and `k8s/deploy.sh` for the one-time cluster bootstrap. Compared with the original plan, EKS Auto Mode replaces self-managed node groups and the cluster autoscaler, and pods get AWS access through IRSA: each service account carries an `eks.amazonaws.com/role-arn` annotation for its own least-privilege IAM role, and the role trusts only that service account through the cluster OIDC provider (`sub` and `aud` conditions). The OIDC provider belongs to one cluster, so after rebuilding the cluster the layers with pod roles (`compute`, `services`, `observability`, `database`) are applied again to point their trust at the new provider.

Transcode jobs come from the upload service's `VideoUploaded` event, not from S3 notifications, so each confirmed upload is transcoded exactly once.

Terraform state lives in S3, encrypted with KMS, and is locked with S3 lockfiles (Terraform 1.10+) instead of a DynamoDB table. The storage and messaging layers cost almost nothing when idle. The compute layer does not: EKS charges for its control plane by the hour and the NAT gateway has an hourly charge too, so apply that layer when you need it and destroy it afterwards.

## Transcode pipeline

```
  ┌──────────┐     ┌─────────────┐     ┌──────────┐     ┌──────────────┐
  │  User    │     │             │     │          │     │  FFmpeg      │
  │  uploads │────▶│ EventBridge │────▶│   SQS    │────▶│  Workers     │
  │  to S3   │     │  (S3 Event) │     │  Queue   │     │  (Spot/KEDA) │
  └──────────┘     └─────────────┘     └──────────┘     └──────┬───────┘
                                            │                   │
                                            ▼                   ▼
                                       ┌──────────┐     ┌──────────────┐
                                       │   DLQ    │     │  Processed   │
                                       │ (Failed) │     │  S3 Bucket   │
                                       └──────────┘     └──────────────┘
```

The worker runs as a KEDA ScaledJob: for every message in the SQS queue KEDA starts a Kubernetes Job (up to 4 at once), the pod transcodes exactly one video and exits. A Job is never scaled down halfway through a video the way a Deployment pod can be, so long videos are not restarted from scratch. With an empty queue there are no worker Jobs at all (scale to zero). To keep the first upload from waiting for a Spot node and the FFmpeg image pull, a low-priority placeholder pod runs the worker image with `sleep` on the transcode pool during active hours (08:00 to 24:00 Vietnam time, a KEDA cron trigger). A new Job preempts the placeholder and starts on that warm node within seconds; the placeholder goes back to Pending and Karpenter brings up a node for it. Outside those hours the placeholder scales to zero too, so the pool costs nothing. The workers run on Spot instances, which AWS prices at up to 90% below on-demand. A job that fails three times moves to the dead letter queue for inspection. Each video gets HLS renditions at the resolutions its source supports (never upscaled, aspect ratio preserved) plus a thumbnail.

## GitOps and delivery

```
git push main ─▶ GitHub Actions: tests, Checkov, build, Trivy
                     │ GitHub OIDC ─▶ STS ─▶ CI role (push to ECR only)
                     ▼
                 ECR: images tagged with the commit SHA
                     │
                     ▼
                 StreamingVideo-config: envs/dev newTag + base ref = that commit
                     │
                     ▼
                 ArgoCD (App-of-Apps) ─▶ migration Jobs ─▶ Argo Rollouts canary
                                                            │ Prometheus analysis
                                                            ├─ pass: promote
                                                            └─ fail: abort, back to stable
```

ArgoCD runs in the cluster (`k8s/argocd/`). `install.sh` applies a single root Application that syncs `apps/` of the config repository: cluster resources (NodePools, PriorityClasses, IngressClass), KEDA, Argo Rollouts and the app, in that order through sync waves. The app's `envs/dev` pins the base manifests of this repository (`k8s/app/base`, `k8s/db`) to the same commit as the image tags, so a deploy never mixes manifests and images from different commits. Rolling back by hand is a `git revert` in the config repository. Automated sync has prune and self-heal on, so hand edits on the cluster are reverted to what Git says. Secrets stay out of Git: `k8s/deploy.sh` creates them on the cluster.

Each HTTP service is an Argo Rollout. A new version starts as one canary pod taking about half the traffic for three minutes while a shared `ClusterAnalysisTemplate` (`k8s/app/base/analysis.yaml`) queries Prometheus every minute for the canary pods only: 5xx rate under 5% and p95 latency under one second. The first failed measurement aborts the rollout and traffic goes back to the stable pods. To rehearse it, set `FAULT_INJECT_5XX_RATE=0.5` on one service in a commit, drive some traffic (`SCENARIO=smoke ./tests/load/run.sh api.js`) and watch `kubectl argo rollouts -n streamforge get rollout streamforge-catalog --watch`.

| Stage | Tool | Status |
| --- | --- | --- |
| Build and test | GitHub Actions | Built (unit and PostgreSQL tests, Terraform fmt/validate) |
| Policy and image scanning | Checkov, Trivy | Built, both block the pipeline |
| Image push | GitHub Actions with GitHub OIDC | Built, `main` only |
| Config update | GitHub Actions with a deploy key | Built, commits to the config repository |
| Deploy | ArgoCD App-of-Apps | Built |
| Progressive rollout | Argo Rollouts | Built: canary, Prometheus analysis, automatic rollback |

CI needs, in the repository settings: variable `AWS_CI_ROLE_ARN` (output `github_ci_role_arn` of `terraform/layers/cicd`), variable `CONFIG_REPOSITORY` (`22127378/StreamingVideo-config`) and secret `CONFIG_REPO_DEPLOY_KEY` (private half of a deploy key with write access on the config repository). Without them CI still tests and scans, it just does not publish.

## Live streaming

Each signed-in user can open one channel from the Studio page (`#/studio`). The live service creates an Amazon IVS channel for it and shows the RTMPS ingest address and stream key to paste into OBS; the key can be rotated. Video goes from OBS to IVS and from IVS's CDN to viewers, never through the cluster. The service tracks which channels are live with `ListStreams` (cached for a few seconds), and the Live page (`#/live`) lists live channels first, then the ones you subscribed to.

On a channel page viewers can subscribe and chat. Chat messages live in the service's own schema; browsers poll for new ones every two seconds using the last message id they have, so any pod can answer and no WebSocket or shared broker is needed. Every message shows a badge for the channel owner and for subscribers, worked out from the current subscription when messages are read, so unsubscribing removes the badge. Owners can delete messages, each user can post at most one message per second, and messages older than seven days are pruned. Names shown publicly are the part of the email before the `@`.

Locally MediaMTX takes IVS's place: OBS publishes to `rtmp://localhost:1935/live` with the key from the Studio page, and MediaMTX asks the live service (`/internal/live/auth`) whether the key matches before accepting the stream.

## Security

| Concern | Approach |
| --- | --- |
| CI/CD authentication | GitHub OIDC, so CI holds no static AWS keys; the role only pushes to ECR from `main` |
| Pod permissions | IRSA (OIDC of the cluster), one least-privilege IAM role per service, trust limited to one service account |
| User sign-in | Cognito with SRP, so the password is never sent as plain text |
| Database access | IAM auth tokens instead of stored passwords, TLS required |
| Container scanning | Trivy in CI blocks images with known CVEs |
| Infrastructure scanning | Checkov on Terraform and rendered Kubernetes manifests; exceptions are written next to the resource with a reason, project-wide ones in `.checkov.yaml` |
| Pod hardening | Non-root, read-only root filesystem, no capabilities, no service account token mounted |
| Origin access | The ALB only accepts traffic from CloudFront |
| Content protection | Short-lived CloudFront signed cookies per tier |
| State encryption | Terraform state in S3, encrypted with KMS |

```
GitHub Actions (OIDC) ──▶ AWS STS ──▶ Temporary Credentials
                                          │
EKS Pod (IRSA token) ─▶ AWS STS ──▶ Per-service IAM Role
                                          │
User ──▶ CloudFront (Signed Cookie) ──▶ ALB ──▶ EKS
              │
              └── Short-lived, tier-gated access
```

On AWS, the API checks the user's Cognito groups and sets three CloudFront cookies limited to `/videos/<id>/` for two hours. Locally there is no Cognito, so `/api/auth/dev-login` issues a JWT signed by `JWT_SECRET` for any email and tier. That mode is for development only.

### Free and Premium

| | Free | Premium (group `premium` or `admin`) |
| --- | --- | --- |
| Free videos | Yes | Yes |
| Premium videos | Only the ones they uploaded themselves | Yes |
| Highest quality | 720p | 1080p |

Every video carries a tier chosen by the uploader. The worker writes renditions up to 720p under `<id>/sd/` together with an `sd/master.m3u8` that lists only those, and anything higher under `<id>/hd/`. A free user's cookie policy covers `/videos/<id>/sd/*` only, so CloudFront answers 403 for the 1080p playlist and segments even if the URL is known. A premium user's policy covers `/videos/<id>/*` and the API hands out the full `master.m3u8`. "Upgrade to Premium" adds the user to the Cognito group; there is no payment step.

Each playback start counts a view, and signed-in users who can watch a video can rate it 1 to 5 stars (one rating per user, re-rating overwrites). The home page lists READY videos filtered by tier and upload period and sorted by newest, oldest, views or rating, with keyset pagination for each sort order. `scripts/seed-demo-videos.sh` uploads generated sample videos, and `SEED_DEMO_STATS=true ./k8s/deploy.sh` gives READY videos without any stats some sample views and ratings (stored under `demo:` user ids).

## Deploying to AWS

Requirements: AWS CLI v2, Terraform 1.10 or newer, kubectl, Helm 3 and Docker. The step-by-step guide, including apply order and teardown, is in `terraform/README.md`. In short:

```bash
# Terraform layers, in order
backend -> storage -> messaging -> identity -> networking -> compute
        -> auth -> database -> services -> observability -> delivery

terraform -chdir=terraform/layers/cicd apply   # once: GitHub OIDC role for CI

git clone git@github.com:22127378/StreamingVideo-config.git ../StreamingVideo-config
./k8s/deploy.sh              # secrets, DB migrations, writes ../StreamingVideo-config/envs/dev
(cd ../StreamingVideo-config && git commit -am "Configure dev" && git push)
./k8s/argocd/install.sh      # ArgoCD and the root Application; it installs KEDA, Argo Rollouts and the app
./k8s/monitoring/install.sh  # Prometheus, Loki, Alloy, Grafana (needed by the canary analysis)
./src/frontend/deploy.sh     # build the frontend and upload it to the web bucket
BASE_URL=https://<cloudfront-domain> ./tests/e2e/smoke.sh
```

## Project structure

```
streamforge/
├── docker-compose.yml            # LocalStack, PostgreSQL, services, worker and gateway (--profile app)
├── docker/                       # Dockerfiles, gateway.nginx.conf, mediamtx.yml
├── docs/                         # architecture.drawio, test-plan.md
├── scripts/                      # LocalStack init, demo data
├── src/
│   ├── shared/                   # code shared by the services
│   ├── account-service/          # /api/auth
│   ├── upload-service/           # /api/uploads, schema upload
│   ├── catalog-service/          # /api/videos, schema catalog, event consumer
│   ├── playback-service/         # /api/playback
│   ├── live-service/             # /api/live, schema live, Amazon IVS
│   ├── transcode-worker/         # FFmpeg transcoding worker
│   └── frontend/                 # React app
├── k8s/
│   ├── cluster/                  # NodePools, PriorityClasses, IngressClass, StorageClass
│   ├── app/                      # five Rollouts, canary analysis, worker (KEDA ScaledJob), placeholder, Ingress
│   ├── db/                       # Migration Jobs (catalog, upload, live)
│   ├── argocd/                   # ArgoCD values, root Application (App-of-Apps), install script
│   ├── monitoring/               # Helm values, alert rules, Grafana dashboard
│   └── deploy.sh
├── tests/                        # e2e smoke test, k6 load tests
├── .checkov.yaml                 # Project-wide Checkov decisions
├── .github/workflows/ci.yml      # Tests, Checkov, image build, Trivy, push via OIDC, config repo update
└── terraform/
    ├── modules/                  # backend, budget, s3, sqs, dynamodb, app-iam
    └── layers/                   # backend, cicd, storage, messaging, identity, networking, compute,
                                  # auth, database, services, observability, delivery
```

## Contributing

Create a branch, commit with the project's message format (`[NAMESPACE] Short description`, see `.claude/skills/commit/SKILL.md`), and open a pull request. Enable the commit hooks once per clone:

```bash
git config core.hooksPath .githooks
```

## License

MIT. See [LICENSE](LICENSE).
