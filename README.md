# StreamForge

A video streaming platform on AWS EKS. Personal project, June to August 2026.

Users upload a video, a worker transcodes it into adaptive bitrate HLS with FFmpeg, and players stream it through CloudFront. Transcode workers scale to zero on an empty queue and run on Spot, delivery is GitOps with ArgoCD, and there are no long-lived AWS keys anywhere. The EKS control plane and NAT gateway still cost roughly $105 a month while the cluster exists, so the cluster is meant to be created for demos and destroyed afterwards.

## Current state

What exists in this repo today:

- A local AWS stack on LocalStack (S3, SQS with a dead letter queue, DynamoDB), started with Docker Compose.
- `src/api`: an Express REST API that issues S3 presigned upload URLs, tracks video metadata in DynamoDB, queues transcode jobs on SQS, and issues JWT playback tokens for free and premium tiers.
- `src/transcode-worker`: an SQS consumer that downloads the source video, probes it, generates a thumbnail, transcodes up to four HLS renditions (1080p, 720p, 480p, 360p), writes a master playlist, uploads everything to the processed bucket and marks the video `READY`.
- Dockerfiles for both services in `docker/`, and a GitHub Actions workflow that runs the tests, builds both images and fails on fixable HIGH or CRITICAL vulnerabilities reported by Trivy.

Not built yet: the frontend, the Terraform modules, Kubernetes manifests and the deploy half of CI/CD. The sections below describe the target design for those parts.

## Running locally

Requirements: Docker. Node.js 20 or newer if you run the services outside Docker, and optionally the AWS CLI for the verify script.

Everything in Docker:

```bash
docker compose --profile app up -d --build    # LocalStack, API on http://localhost:4000, worker
```

Or LocalStack in Docker and the services with npm, which reloads on code changes:

```bash
cp .env.example .env
docker compose up -d                # LocalStack only; buckets, queues and table are created on startup
./scripts/verify-local.sh           # or scripts/verify-local.ps1 on Windows

cd src/api && npm install && npm run dev                 # http://localhost:4000
cd src/transcode-worker && npm install && npm run dev    # in a second terminal
```

`src/api/api.http` has sample requests for the full flow: request an upload URL, PUT the file to it, call `/api/videos/complete`, then poll `/api/videos/:id` until the status is `READY`.

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
│  │                    DynamoDB (Metadata)                      │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

Editable diagrams of both the local flow and the AWS design are in `docs/architecture.drawio` (open it at app.diagrams.net or with the Draw.io VS Code extension).

In the cloud design, an S3 upload event reaches SQS through EventBridge. Locally there is no EventBridge, so the API sends the SQS message itself when the client calls `POST /api/videos/complete`.

## Tech stack

| Layer | Technology |
| --- | --- |
| Container orchestration | AWS EKS |
| Infrastructure | Terraform (10 modules, 5 layers) |
| Networking | VPC, CloudFront, ALB |
| Storage | S3 for video assets and Terraform state, DynamoDB |
| Messaging | EventBridge, SQS, DLQ |
| Transcoding | FFmpeg on Spot instances |
| Autoscaling | KEDA, scaling to zero on queue depth |
| GitOps | ArgoCD with a separate config repo |
| CI/CD | GitHub Actions, Argo Rollouts |
| Monitoring and scanning | Prometheus, Trivy |
| Security | GitHub OIDC, IRSA, CloudFront signed cookies, KMS |

## Infrastructure

Terraform lives in `terraform/`, split into layers that are applied separately. See `terraform/README.md` for the apply order and how to run the services locally against real AWS.

| Layer | Status | Contents |
| --- | --- | --- |
| backend | Built | State bucket (versioned, KMS-encrypted, TLS only), AWS Budget alarm |
| storage | Built | Raw and processed S3 buckets, DynamoDB `videos` table with its GSI |
| messaging | Built | Transcode SQS queue and DLQ |
| identity | Built | Least-privilege IAM policies for the API and worker, plus dev roles |
| networking | Built | VPC across 2 AZs, public and private subnets, one NAT gateway |
| compute | Built | EKS Auto Mode, ECR, EKS Pod Identity roles using the identity policies, ALB security group open to CloudFront only |
| delivery | Built | CloudFront: HLS from the processed bucket via OAC, `/api/*` to the ALB. Signed cookies not done yet |

The app runs on EKS from `k8s/`: NodePools for an on-demand API pool and a Spot transcode pool, KEDA scaling the worker from 0 on queue depth, and `k8s/deploy.sh` to build, push and apply. Compared with the original plan, EKS Auto Mode replaces self-managed node groups and the cluster autoscaler, and EKS Pod Identity replaces IRSA. ArgoCD is not set up yet.

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
| Pod permissions | IRSA, one least-privilege IAM role per service |
| Container scanning | Trivy in CI blocks images with known CVEs |
| Origin access | The ALB only accepts traffic from CloudFront |
| Content protection | Short-lived CloudFront signed cookies per tier |
| State encryption | Terraform state in S3, encrypted with KMS |

```
GitHub Actions (OIDC) ──▶ AWS STS ──▶ Temporary Credentials
                                          │
EKS Pod (IRSA) ─────────▶ AWS STS ──▶ Per-service IAM Role
                                          │
User ──▶ CloudFront (Signed Cookie) ──▶ ALB ──▶ EKS
              │
              └── Short-lived, tier-gated access
```

Locally, the API simulates tier-gated playback with JWTs signed by `JWT_SECRET`. Anyone can request a premium token, so this is for development only.

## Deploying to AWS (planned)

Requirements: AWS CLI v2, Terraform 1.5 or newer, kubectl, Helm 3, the ArgoCD CLI and Docker.

```bash
# 1. Clone the repository
git clone https://github.com/<your-username>/streamforge.git
cd streamforge

# 2. Initialize Terraform backend (Layer 5 first)
cd terraform/layers/backend
terraform init && terraform apply

# 3. Provision infrastructure layer by layer
cd ../networking && terraform init && terraform apply
cd ../compute    && terraform init && terraform apply
cd ../storage    && terraform init && terraform apply
cd ../messaging  && terraform init && terraform apply

# 4. Configure kubectl
aws eks update-kubeconfig --name streamforge-cluster --region <region>

# 5. Install ArgoCD
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 6. Deploy application via ArgoCD
argocd app create streamforge \
  --repo https://github.com/<your-username>/streamforge-config.git \
  --path k8s/ \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace default
```

## Project structure

```
streamforge/
├── docker-compose.yml            # LocalStack, plus API and worker with --profile app
├── docker/                       # api.Dockerfile, worker.Dockerfile
├── docs/architecture.drawio      # Local flow and AWS design diagrams
├── scripts/                      # LocalStack init and verify scripts
├── src/
│   ├── api/                      # REST API
│   ├── transcode-worker/         # FFmpeg transcoding worker
│   └── frontend/                 # Video player and UI (not built yet)
├── .github/workflows/ci.yml      # Tests, image build, Trivy scan, Terraform checks
├── terraform/
│   ├── modules/                  # backend, budget, s3, sqs, dynamodb, app-iam
│   └── layers/                   # backend, storage, messaging, identity
│
│   Planned:
├── terraform/layers/             # networking, compute, delivery
├── k8s/                          # deployments, services, keda, rollouts
└── .github/workflows/cd.yml      # Push to ECR via OIDC, update the config repo
```

## Contributing

Create a branch, commit with the project's message format (`[NAMESPACE] Short description`, see `.claude/skills/commit/SKILL.md`), and open a pull request. Enable the commit hooks once per clone:

```bash
git config core.hooksPath .githooks
```

## License

MIT. See [LICENSE](LICENSE).
