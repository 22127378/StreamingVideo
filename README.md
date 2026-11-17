# StreamForge

A video streaming platform on AWS EKS. Personal project, June to August 2026.

Users upload a video, a worker transcodes it into adaptive bitrate HLS with FFmpeg, and players stream it through CloudFront. Transcode workers scale on queue depth and run on Spot, premium videos are protected with CloudFront signed cookies, and no pod holds long-lived AWS keys. The EKS control plane and NAT gateway alone cost roughly $105 a month while the cluster exists, so the cluster is meant to be created for demos and destroyed afterwards.

## Current state

What exists in this repo today:

- A local stack in Docker Compose: LocalStack (S3, SQS with a dead letter queue) and PostgreSQL.
- `src/api`: an Express REST API that issues S3 presigned upload URLs, stores video metadata in PostgreSQL (Aurora Serverless v2 on AWS), queues transcode jobs on SQS, signs users in with Cognito and hands out CloudFront signed cookies scoped to one video.
- `src/transcode-worker`: an SQS consumer that downloads the source video, probes it, generates a thumbnail, transcodes up to four HLS renditions (1080p, 720p, 480p, 360p), writes a master playlist, uploads everything to the processed bucket and marks the video `READY`.
- Dockerfiles for both services in `docker/`, and a GitHub Actions workflow that runs the tests, builds both images and fails on fixable HIGH or CRITICAL vulnerabilities reported by Trivy.

- `src/frontend`: a React app with in-page Cognito sign-in, uploads with progress, transcode status and an HLS player with a quality selector. It is served from the same CloudFront domain as the API (`/api/*`), the HLS output (`/videos/*`) and Grafana (`/grafana`).
- Monitoring on the cluster: Prometheus, Loki, Alloy and Grafana, with alerts sent by email through SNS (`k8s/monitoring/`).

Not built yet: a custom domain, ArgoCD with Argo Rollouts, and the deploy half of CI/CD (deploys run from `k8s/deploy.sh`).

## Running locally

Requirements: Docker. Node.js 20 or newer if you run the services outside Docker, and optionally the AWS CLI for the verify script.

Everything in Docker:

```bash
docker compose --profile app up -d --build    # LocalStack, API on http://localhost:4000, worker
```

Or LocalStack in Docker and the services with npm, which reloads on code changes:

```bash
cp .env.example .env
docker compose up -d                # LocalStack and PostgreSQL; buckets and queues are created on startup
./scripts/verify-local.sh           # or scripts/verify-local.ps1 on Windows

cd src/api && npm install && node src/db/migrate.js     # schema and DB users, once
npm run dev                                              # http://localhost:4000
cd src/transcode-worker && npm install && npm run dev    # in a second terminal
```

`src/api/api.http` has sample requests for the full flow: request an upload URL, PUT the file to it, call `/api/videos/complete`, then poll `/api/videos/:id` until the status is `READY`.

Test scenarios for the deployed stack (functional, security, resilience and k6 load tests) are in `docs/test-plan.md`, with scripts under `tests/`.

LocalStack is pinned to 4.4 because later images refuse to start without a `LOCALSTACK_AUTH_TOKEN`. If `.localstack/` holds a table from an older version of the init script, delete that directory before starting (some files in it are owned by root).

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        CloudFront (CDN)                          │
│                    ┌─────────────────────┐                       │
│                    │  Tier-gated Playback │                      │
│                    │  (Signed Cookies)    │                      │
│                    └────────┬────────────┘                       │
│                             │                                    │
│              ┌──────────────▼──────────────┐                     │
│              │     Application Load        │                     │
│              │     Balancer (ALB)           │                     │
│              │   (CloudFront-only access)   │                     │
│              └──────────────┬──────────────┘                     │
│                             │                                    │
│              ┌──────────────▼──────────────┐                     │
│              │        AWS EKS Cluster       │                     │
│              │  ┌─────────┐ ┌────────────┐ │                     │
│              │  │ App Pods│ │Transcode   │ │                     │
│              │  │         │ │Workers     │ │                     │
│              │  │         │ │(FFmpeg on  │ │                     │
│              │  │         │ │ Spot)      │ │                     │
│              │  └─────────┘ └────────────┘ │                     │
│              │         KEDA Autoscaler      │                     │
│              └──────────────────────────────┘                     │
│                                                                  │
│  ┌─────────┐    ┌─────────────┐    ┌──────┐    ┌──────────────┐ │
│  │   S3    │───▶│ EventBridge │───▶│ SQS  │───▶│  DLQ (Dead   │ │
│  │ (Upload)│    │             │    │      │    │  Letter Queue)│ │
│  └─────────┘    └─────────────┘    └──────┘    └──────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │           Aurora PostgreSQL Serverless v2 (Metadata)        │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
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
| Autoscaling | KEDA, scaling to zero on queue depth |
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
| identity | Built | Least-privilege IAM policies for the API and worker, plus dev roles |
| networking | Built | VPC across 2 AZs, public and private subnets, one NAT gateway |
| compute | Built | EKS Auto Mode, ECR, EKS Pod Identity roles using the identity policies, ALB security group open to CloudFront only |
| delivery | Built | CloudFront: frontend bucket, HLS from the processed bucket via OAC behind a signed-cookie key group, `/api/*` and `/grafana*` to the ALB |
| auth | Built | Cognito user pool, app client and the `premium` and `admin` groups |
| database | Built | Aurora PostgreSQL 17 Serverless v2 (0.5 ACU minimum), IAM auth for the API and worker, master secret in Secrets Manager |
| observability | Built | SNS alert topic, Loki bucket, Pod Identity for Loki, Alertmanager and Grafana, CloudWatch alarms on the DLQ, stuck queue and CloudFront 5xx |

The app runs on EKS from `k8s/`: NodePools for an on-demand API pool and a Spot transcode pool, KEDA scaling the worker on queue depth (one worker kept warm to avoid cold starts), a migration Job for the database, and `k8s/deploy.sh` to build, push and apply. Compared with the original plan, EKS Auto Mode replaces self-managed node groups and the cluster autoscaler, and EKS Pod Identity replaces IRSA. ArgoCD is not set up yet.

EventBridge is left out for now. The API already queues a job when the client calls `/api/videos/complete`, so adding an S3 → EventBridge → SQS rule on top would transcode every video twice.

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

KEDA scales the workers from zero based on SQS queue depth, and the workers run on Spot instances, which AWS prices at up to 90% below on-demand. A job that fails three times moves to the dead letter queue for inspection. Each video gets HLS renditions at the resolutions its source supports (never upscaled, aspect ratio preserved) plus a thumbnail.

## GitOps and delivery (planned)

Kubernetes manifests live in a separate config repository. ArgoCD watches it and syncs the cluster. Argo Rollouts runs canary or blue/green releases and rolls back automatically when Prometheus metrics show a regression.

```
GitHub Push → GitHub Actions → Build & Test → Trivy Scan → Push Image → Update Config Repo → ArgoCD Sync → Argo Rollout
```

| Stage | Tool | Description |
| --- | --- | --- |
| Build and test | GitHub Actions | Compile, lint, unit tests |
| Security scan | Trivy | Container image vulnerability scan |
| Image registry | ECR | Push container images |
| Deploy | ArgoCD | Sync from the config repo to EKS |
| Progressive rollout | Argo Rollouts | Canary or blue/green with metric analysis |
| Monitoring | Prometheus | Metrics that drive rollback decisions |

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

On AWS, the API checks the user's Cognito groups and sets three CloudFront cookies limited to `/videos/<id>/` for two hours. Free users get cookies only for free videos; `premium` and `admin` users get them for every video. Locally there is no Cognito, so `/api/auth/dev-login` issues a JWT signed by `JWT_SECRET` for any email and tier. That mode is for development only.

## Deploying to AWS

Requirements: AWS CLI v2, Terraform 1.10 or newer, kubectl, Helm 3 and Docker. The step-by-step guide, including apply order and teardown, is in `terraform/README.md`. In short:

```bash
# Terraform layers, in order
backend -> storage -> messaging -> identity -> networking -> compute
        -> auth -> database -> observability -> delivery

./k8s/deploy.sh              # images, KEDA, DB migration, API and worker
./k8s/monitoring/install.sh  # Prometheus, Loki, Alloy, Grafana
./src/frontend/deploy.sh     # build the frontend and upload it to the web bucket
BASE_URL=https://<cloudfront-domain> ./tests/e2e/smoke.sh
```

## Project structure

```
streamforge/
├── docker-compose.yml            # LocalStack and PostgreSQL, plus API and worker with --profile app
├── docker/                       # api.Dockerfile, worker.Dockerfile
├── docs/                         # architecture.drawio, test-plan.md
├── scripts/                      # LocalStack init and verify scripts
├── src/
│   ├── api/                      # REST API, database migrations in src/db
│   ├── transcode-worker/         # FFmpeg transcoding worker
│   └── frontend/                 # React app
├── k8s/
│   ├── cluster/                  # NodePools, IngressClass, StorageClass
│   ├── app/                      # API, worker, KEDA ScaledObject, Ingress
│   ├── db/                       # Migration Job
│   ├── monitoring/               # Helm values, alert rules, Grafana dashboard
│   └── deploy.sh
├── tests/                        # e2e smoke test, k6 load tests
├── .github/workflows/ci.yml      # Tests, image build, Trivy scan, Terraform checks
└── terraform/
    ├── modules/                  # backend, budget, s3, sqs, dynamodb, app-iam
    └── layers/                   # backend, storage, messaging, identity, networking,
                                  # compute, auth, database, observability, delivery
```

## Contributing

Create a branch, commit with the project's message format (`[NAMESPACE] Short description`, see `.claude/skills/commit/SKILL.md`), and open a pull request. Enable the commit hooks once per clone:

```bash
git config core.hooksPath .githooks
```

## License

MIT. See [LICENSE](LICENSE).
