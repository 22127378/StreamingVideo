# StreamForge

A video streaming platform on AWS EKS. Personal project, June to August 2026.

Users upload a video, a worker transcodes it into adaptive bitrate HLS with FFmpeg, and players stream it through CloudFront. The design aims for near-zero idle cost (transcode workers scale to zero on an empty queue and run on Spot), GitOps delivery with ArgoCD, and no long-lived AWS keys anywhere.

## Current state

What exists in this repo today:

- A local AWS stack on LocalStack (S3, SQS with a dead letter queue, DynamoDB), started with Docker Compose.
- `src/api`: an Express REST API that issues S3 presigned upload URLs, tracks video metadata in DynamoDB, queues transcode jobs on SQS, and issues JWT playback tokens for free and premium tiers.
- `src/transcode-worker`: an SQS consumer that downloads the source video, probes it, generates a thumbnail, transcodes up to four HLS renditions (1080p, 720p, 480p, 360p), writes a master playlist, uploads everything to the processed bucket and marks the video `READY`.

Not built yet: the frontend, the Terraform modules, Kubernetes manifests, Dockerfiles and the CI/CD pipeline. The sections below describe the target design for those parts.

## Running locally

Requirements: Docker, Node.js 20 or newer, and optionally the AWS CLI for the verify script.

```bash
cp .env.example .env
docker compose up -d                # LocalStack; buckets, queues and table are created on startup
./scripts/verify-local.sh           # or scripts/verify-local.ps1 on Windows

cd src/api && npm install && npm run dev                 # http://localhost:4000
cd src/transcode-worker && npm install && npm run dev    # in a second terminal
```

`src/api/api.http` has sample requests for the full flow: request an upload URL, PUT the file to it, call `/api/videos/complete`, then poll `/api/videos/:id` until the status is `READY`.

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

## Infrastructure (planned)

Terraform is split into 10 modules applied in 5 layers:

```
terraform/
├── Layer 1 — Networking
│   ├── module: vpc           # VPC, subnets, NAT gateway, route tables
│   └── module: security      # Security groups, NACLs
│
├── Layer 2 — Compute
│   ├── module: eks           # EKS cluster, node groups (on-demand + spot)
│   └── module: keda          # KEDA operator for queue-based autoscaling
│
├── Layer 3 — Storage & Data
│   ├── module: s3            # Video upload bucket, processed output bucket
│   ├── module: dynamodb      # Video metadata, user sessions
│   └── module: cloudfront    # CDN distribution with signed cookies
│
├── Layer 4 — Messaging & Events
│   ├── module: eventbridge   # S3 event rules
│   └── module: sqs           # Processing queue + Dead Letter Queue
│
└── Layer 5 — State & Security
    └── module: backend       # S3 backend + KMS encryption for state
```

Terraform state lives in S3, encrypted with KMS, with a DynamoDB table for state locking. Compute is meant to scale down to nothing when idle, so the standing cost is mostly storage.

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
├── docker-compose.yml            # LocalStack for local development
├── scripts/                      # LocalStack init and verify scripts
├── src/
│   ├── api/                      # REST API
│   ├── transcode-worker/         # FFmpeg transcoding worker
│   └── frontend/                 # Video player and UI (not built yet)
│
│   Planned:
├── terraform/
│   ├── modules/                  # vpc, security, eks, keda, s3, dynamodb,
│   │                             # cloudfront, eventbridge, sqs, backend
│   └── layers/                   # networking, compute, storage, messaging, backend
├── k8s/                          # deployments, services, keda, rollouts
├── docker/                       # api, worker and frontend Dockerfiles
└── .github/workflows/            # ci.yml, cd.yml
```

## Contributing

Create a branch, commit with the project's message format (`[NAMESPACE] Short description`, see `.claude/skills/commit/SKILL.md`), and open a pull request. Enable the commit hooks once per clone:

```bash
git config core.hooksPath .githooks
```

## License

MIT. See [LICENSE](LICENSE).
