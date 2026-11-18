# StreamForge

A video streaming platform on AWS EKS. Personal project, June to August 2026.

Users upload a video, a worker transcodes it into adaptive bitrate HLS with FFmpeg, and players stream it through CloudFront. Transcode workers scale on queue depth and run on Spot, premium videos are protected with CloudFront signed cookies, and no pod holds long-lived AWS keys. The EKS control plane and NAT gateway alone cost roughly $105 a month while the cluster exists, so the cluster is meant to be created for demos and destroyed afterwards.

## Current state

StreamForge is split into microservices. Each one has its own image, Deployment, IAM role and, where it stores data, its own database schema and user. Services never read each other's tables: they talk through events on an EventBridge bus, plus one internal HTTP call from playback to catalog.

| Service | Public routes | Does | Owns |
| --- | --- | --- | --- |
| `src/account-service` | `/api/auth/*` | Sign-in config, current user, upgrade to Premium | Cognito groups |
| `src/upload-service` | `/api/uploads/*` | Presigned S3 upload URL, confirm upload | schema `upload` |
| `src/catalog-service` | `/api/videos/*` | List, detail, my videos, ratings, views, delete; builds its data from events | schema `catalog` |
| `src/playback-service` | `/api/playback/*` | Access check, CloudFront signed cookies, view events | nothing (stateless) |
| `src/transcode-worker` | none | FFmpeg to HLS (KEDA ScaledJob on Spot) | nothing |

`src/shared` holds the code they share (HTTP setup, token checks, logging, metrics, database pool, migrations, events). `src/frontend` is the React app. Monitoring runs on the cluster (Prometheus, Loki, Alloy, Grafana, `k8s/monitoring/`), and ArgoCD syncs `k8s/gitops/dev` from `main`.

Events (source `streamforge.<service>`):

```
upload    --VideoCreated------------------------------> catalog   (video shows as UPLOADING)
upload    --VideoUploaded--+--(detail only)-----------> transcode queue -> worker
                           +--------------------------> catalog   (PROCESSING)
worker    --TranscodeStarted/Completed/Failed---------> catalog   (READY / FAILED)
playback  --VideoViewed-------------------------------> catalog   (view count)
```

The catalog applies events idempotently (it records event ids) and only when the current status allows it, because SQS does not keep order. Events for a deleted video are dropped, and HLS files a worker writes after a delete are removed.

Not built yet: a custom domain, Argo Rollouts, and the deploy half of CI/CD (images are built by `k8s/deploy.sh`, not by GitHub Actions).

## Running locally

Requirements: Docker. Node.js 22 or newer to run tests outside Docker.

```bash
docker compose --profile app up -d --build
```

This starts LocalStack (S3, SQS, EventBridge with the same rules as AWS), PostgreSQL, the two migration jobs, the four services, the worker and an nginx gateway on http://localhost:4000 that routes `/api/*` like the ALB does. Then run the frontend with `cd src/frontend && npm install && npm run dev` (http://localhost:5173). Without Cognito, sign in with any email and pick a tier.

Tests per package: `npm test` in `src/shared`, `src/*-service` and `src/transcode-worker`. The upload and catalog suites also run against PostgreSQL with `DB_TEST=1` (see the comment at the top of each test file). After changing `src/shared`, run `npm install` in the services: they install it as a copy (`install-links=true`).

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
          ┌──────────────┬───────┴──────┬────────────────┐
          ▼              ▼              ▼                ▼
   /api/auth        /api/uploads    /api/videos     /api/playback
   account          upload          catalog ◀────── playback
   (Cognito)        (schema upload) (schema catalog)  internal HTTP
                        │               ▲
                        │ events        │ events (SQS catalog-events)
                        ▼               │
                 ┌───────── EventBridge bus ─────────┐
                 │ VideoUploaded (detail) → SQS transcode → worker (KEDA ScaledJob, Spot)
                 │ all streamforge.* events → catalog │
                 └────────────────────────────────────┘
   Aurora PostgreSQL Serverless v2: one cluster, one schema and one IAM-auth user per service
```

Editable diagrams of both the local flow and the AWS design are in `docs/architecture.drawio` (open it at app.diagrams.net or with the Draw.io VS Code extension).

In the cloud design, an S3 upload event reaches SQS through EventBridge. Locally there is no EventBridge, so the API sends the SQS message itself when the client calls `POST /api/videos/complete`.

## Tech stack

| Layer | Technology |
| --- | --- |
| Container orchestration | AWS EKS |
| Infrastructure | Terraform (6 modules, 10 layers) |
| Networking | VPC, CloudFront, ALB |
| Storage | S3 for video assets and Terraform state, Aurora PostgreSQL Serverless v2 |
| Messaging | EventBridge, SQS, DLQ |
| Transcoding | FFmpeg on Spot instances |
| Autoscaling | KEDA ScaledJob, one Kubernetes Job per queued video |
| GitOps | ArgoCD with a separate config repo |
| CI/CD | GitHub Actions, Argo Rollouts |
| Monitoring and scanning | Prometheus, Loki, Alloy, Grafana, CloudWatch alarms, Trivy |
| Security | Cognito, EKS Pod Identity, IAM database auth, CloudFront signed cookies, KMS |

## Infrastructure

Terraform lives in `terraform/`, split into layers that are applied separately. See `terraform/README.md` for the apply order and how to run the services locally against real AWS.

| Layer | Status | Contents |
| --- | --- | --- |
| backend | Built | State bucket (versioned, KMS-encrypted, TLS only), AWS Budget alarm |
| storage | Built | Raw and processed S3 buckets. The old DynamoDB `videos` table is still here until it is removed |
| messaging | Built | Transcode SQS queue and DLQ |
| identity | Built | IAM policies for the worker (and the old API's dev roles, to be removed) |
| networking | Built | VPC across 2 AZs, public and private subnets, one NAT gateway |
| compute | Built | EKS Auto Mode, ECR (one repository per service), Pod Identity for the worker and KEDA, ALB security group open to CloudFront only |
| delivery | Built | CloudFront: frontend bucket, HLS from the processed bucket via OAC behind a signed-cookie key group, `/api/*` and `/grafana*` to the ALB |
| auth | Built | Cognito user pool, app client and the `premium` and `admin` groups |
| database | Built | Aurora PostgreSQL 17 Serverless v2 (pauses after 10 idle minutes), master secret in Secrets Manager |
| services | Built | EventBridge bus and rules, catalog event queue and DLQ, one IAM role and Pod Identity per service, database connect rights per service user |
| observability | Built | SNS alert topic, Loki bucket, Pod Identity for Loki, Alertmanager and Grafana, CloudWatch alarms on the DLQ, stuck queue and CloudFront 5xx |

The app runs on EKS from `k8s/`: NodePools for an on-demand API pool and a Spot transcode pool, KEDA running the worker as a ScaledJob (one Job per video, scaled to zero, with a placeholder pod keeping a warm node to avoid cold starts), a migration Job for the database, and `k8s/deploy.sh` to build, push and apply. Compared with the original plan, EKS Auto Mode replaces self-managed node groups and the cluster autoscaler, EKS Pod Identity replaces IRSA, and ArgoCD reads its manifests from `k8s/gitops/dev` in this repository instead of a separate config repo.

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

ArgoCD runs in the cluster (`k8s/argocd/`) and watches `k8s/gitops/dev` on `main`. A sync applies the ConfigMaps, runs the database migration Job as a Sync hook and waits for it, then rolls out the API and the worker ScaledJob. Automated sync has prune and self-heal on, so hand edits on the cluster are reverted to what Git says. Secrets stay out of Git: `k8s/deploy.sh` creates them on the cluster.

```
Today:   k8s/deploy.sh (build, push to ECR, write image tag) -> git push -> ArgoCD sync
Planned: GitHub Actions (test, Trivy, push to ECR via OIDC, write image tag) -> ArgoCD sync -> Argo Rollouts
```

| Stage | Tool | Status |
| --- | --- | --- |
| Build and test | GitHub Actions | Built (tests, Trivy scan, Terraform checks) |
| Image build and push | `k8s/deploy.sh` | Built; moving it to GitHub Actions with OIDC is planned |
| Deploy | ArgoCD | Built, syncing from this repository |
| Progressive rollout | Argo Rollouts | Planned: canary with Prometheus analysis and automatic rollback |

## Security

| Concern | Approach |
| --- | --- |
| CI/CD authentication | GitHub OIDC, so CI holds no static AWS keys |
| Pod permissions | EKS Pod Identity, one least-privilege IAM role per service |
| User sign-in | Cognito with SRP, so the password is never sent as plain text |
| Database access | IAM auth tokens instead of stored passwords, TLS required |
| Container scanning | Trivy in CI blocks images with known CVEs |
| Origin access | The ALB only accepts traffic from CloudFront |
| Content protection | Short-lived CloudFront signed cookies per tier |
| State encryption | Terraform state in S3, encrypted with KMS |

```
GitHub Actions (OIDC) ──▶ AWS STS ──▶ Temporary Credentials
                                          │
EKS Pod (Pod Identity) ─▶ AWS STS ──▶ Per-service IAM Role
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

./k8s/deploy.sh              # images, KEDA, DB migrations, the four services and the worker
./k8s/monitoring/install.sh  # Prometheus, Loki, Alloy, Grafana
./k8s/argocd/install.sh      # ArgoCD, then commit and push k8s/gitops/dev to deploy
./src/frontend/deploy.sh     # build the frontend and upload it to the web bucket
BASE_URL=https://<cloudfront-domain> ./tests/e2e/smoke.sh
```

## Project structure

```
streamforge/
├── docker-compose.yml            # LocalStack, PostgreSQL, services, worker and gateway (--profile app)
├── docker/                       # service.Dockerfile, worker.Dockerfile, gateway.nginx.conf
├── docs/                         # architecture.drawio, test-plan.md
├── scripts/                      # LocalStack init, demo data
├── src/
│   ├── shared/                   # code shared by the services
│   ├── account-service/          # /api/auth
│   ├── upload-service/           # /api/uploads, schema upload
│   ├── catalog-service/          # /api/videos, schema catalog, event consumer
│   ├── playback-service/         # /api/playback
│   ├── transcode-worker/         # FFmpeg transcoding worker
│   └── frontend/                 # React app
├── k8s/
│   ├── cluster/                  # NodePools, IngressClass, StorageClass
│   ├── app/                      # the four services, worker (KEDA ScaledJob), Ingress
│   ├── db/                       # Migration Jobs (catalog, upload)
│   ├── gitops/dev/               # What ArgoCD syncs: image tags and config (written by deploy.sh)
│   ├── argocd/                   # ArgoCD values, Application, install script
│   ├── monitoring/               # Helm values, alert rules, Grafana dashboard
│   └── deploy.sh
├── tests/                        # e2e smoke test, k6 load tests
├── .github/workflows/ci.yml      # Tests, image build, Trivy scan, Terraform checks
└── terraform/
    ├── modules/                  # backend, budget, s3, sqs, dynamodb, app-iam
    └── layers/                   # backend, storage, messaging, identity, networking, compute,
                                  # auth, database, services, observability, delivery
```

## Contributing

Create a branch, commit with the project's message format (`[NAMESPACE] Short description`, see `.claude/skills/commit/SKILL.md`), and open a pull request. Enable the commit hooks once per clone:

```bash
git config core.hooksPath .githooks
```

## License

MIT. See [LICENSE](LICENSE).
