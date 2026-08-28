# 🎬 StreamForge

> **Video Streaming Platform on AWS EKS**
> Personal Project · June 2026 – August 2026 · [GitHub](#)

---

## 📋 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Infrastructure (IaC)](#infrastructure-iac)
- [Transcode Pipeline](#transcode-pipeline)
- [GitOps & Delivery](#gitops--delivery)
- [Security](#security)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Contributing](#contributing)

---

## Overview

**StreamForge** is a fully cloud-native video streaming platform built on **AWS EKS**, designed from scratch with a focus on:

- **Zero-to-cost infrastructure** — state managed on S3 + KMS, all resources provisioned via Terraform
- **Event-driven transcoding** — serverless pipeline that auto-scales based on queue depth
- **GitOps delivery** — ArgoCD-powered continuous deployment with automatic rollbacks
- **End-to-end security** — no static keys, OIDC authentication, least-privilege IAM, and signed cookies for content protection

---

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

---

## Tech Stack

| Layer              | Technology                                       |
| ------------------ | ------------------------------------------------ |
| **Container Orchestration** | AWS EKS (Kubernetes)                    |
| **Infrastructure** | Terraform (10 modules, 5 layers)                 |
| **Networking**     | VPC, CloudFront, ALB                             |
| **Storage**        | S3 (video assets + Terraform state), DynamoDB    |
| **Messaging**      | EventBridge → SQS → DLQ                         |
| **Transcoding**    | FFmpeg (on Spot Instances)                       |
| **Autoscaling**    | KEDA (scale-to-zero on queue depth)              |
| **GitOps**         | ArgoCD (separate config repo)                    |
| **CI/CD**          | GitHub Actions, Argo Rollouts                    |
| **Monitoring**     | Prometheus, Trivy (security scanning)            |
| **Security**       | GitHub OIDC, IRSA, Signed Cookies, KMS           |

---

## Infrastructure (IaC)

A fully **Infrastructure as Code** platform provisioned with Terraform:

### Terraform Modules (10 modules across 5 layers)

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

### State Management

- **Remote state**: Stored in S3 with server-side encryption (KMS)
- **State locking**: DynamoDB table for concurrent access protection
- **Zero cost at rest**: Resources designed to scale down to zero when idle

---

## Transcode Pipeline

An **event-driven, serverless-inspired** transcoding pipeline:

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

### Key Features

- **KEDA Autoscaling**: Workers scale from **0 → N** based on SQS queue depth
- **Spot Instances**: Transcode workers run on EC2 Spot for up to **90% cost savings**
- **Dead Letter Queue**: Failed jobs are automatically routed to DLQ for retry/inspection
- **FFmpeg**: Industry-standard transcoding (adaptive bitrate, multiple resolutions)

---

## GitOps & Delivery

### ArgoCD Setup

- **Separate config repository** for Kubernetes manifests (GitOps best practice)
- **Automatic sync**: ArgoCD watches the config repo and reconciles cluster state
- **Argo Rollouts**: Canary/blue-green deployments with automatic rollback on failure
- **Prometheus-driven rollbacks**: Rollouts monitored by Prometheus metrics; automatic rollback on anomaly detection

### CI/CD Pipeline

```
GitHub Push → GitHub Actions → Build & Test → Trivy Scan → Push Image → Update Config Repo → ArgoCD Sync → Argo Rollout
```

| Stage              | Tool                  | Description                                    |
| ------------------ | --------------------- | ---------------------------------------------- |
| Build & Test       | GitHub Actions        | Compile, lint, unit tests                      |
| Security Scan      | Trivy                 | Container image vulnerability scanning         |
| Image Registry     | ECR                   | Push container images                          |
| Deploy             | ArgoCD                | GitOps sync from config repo to EKS            |
| Progressive Rollout| Argo Rollouts         | Canary/blue-green with metric analysis         |
| Monitoring         | Prometheus            | Metrics-driven rollback decisions              |

---

## Security

### 🔐 Zero Static Keys

| Feature                        | Implementation                                    |
| ------------------------------ | ------------------------------------------------- |
| **CI/CD Authentication**       | GitHub OIDC — no static AWS keys in CI            |
| **Pod-level IAM**              | IRSA (IAM Roles for Service Accounts) — per-pod least privilege |
| **Container Scanning**         | Trivy in CI pipeline — block deployments on CVEs  |
| **CDN Access Control**         | CloudFront-only ALB — origin not publicly accessible |
| **Content Protection**         | Signed cookies — short-lived, tier-gated playback |
| **State Encryption**           | KMS-encrypted Terraform state in S3               |

### Security Architecture

```
GitHub Actions (OIDC) ──▶ AWS STS ──▶ Temporary Credentials
                                          │
EKS Pod (IRSA) ─────────▶ AWS STS ──▶ Per-service IAM Role
                                          │
User ──▶ CloudFront (Signed Cookie) ──▶ ALB ──▶ EKS
              │
              └── Short-lived, tier-gated access
```

---

## Getting Started

### Prerequisites

- AWS CLI v2 configured
- Terraform >= 1.5
- kubectl
- Helm 3
- ArgoCD CLI
- Docker

### Quick Start

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

---

## Project Structure

```
streamforge/
├── terraform/                    # Infrastructure as Code
│   ├── modules/                  # 10 reusable Terraform modules
│   │   ├── vpc/
│   │   ├── security/
│   │   ├── eks/
│   │   ├── keda/
│   │   ├── s3/
│   │   ├── dynamodb/
│   │   ├── cloudfront/
│   │   ├── eventbridge/
│   │   ├── sqs/
│   │   └── backend/
│   └── layers/                   # 5 deployment layers
│       ├── networking/
│       ├── compute/
│       ├── storage/
│       ├── messaging/
│       └── backend/
│
├── k8s/                          # Kubernetes manifests (or in config repo)
│   ├── deployments/
│   ├── services/
│   ├── keda/
│   └── rollouts/
│
├── src/                          # Application source code
│   ├── api/                      # REST API / Backend
│   ├── transcode-worker/         # FFmpeg transcoding worker
│   └── frontend/                 # Video player / UI
│
├── .github/
│   └── workflows/                # GitHub Actions CI/CD
│       ├── ci.yml
│       └── cd.yml
│
├── docker/                       # Dockerfiles
│   ├── api.Dockerfile
│   ├── worker.Dockerfile
│   └── frontend.Dockerfile
│
└── README.md
```

---

## Key Metrics & Highlights

| Metric                          | Value                                          |
| ------------------------------- | ---------------------------------------------- |
| Terraform Modules               | 10                                             |
| Infrastructure Layers           | 5                                              |
| Static Keys in Production       | **0** (GitHub OIDC + IRSA)                     |
| Minimum Idle Cost               | **~$0** (scale-to-zero with KEDA + Spot)       |
| Transcode Cost Savings          | Up to **90%** (Spot Instances)                 |
| Deployment Strategy             | Canary/Blue-Green with auto-rollback           |
| Security Scanning               | Automated via Trivy in CI                      |

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  <b>Built with ❤️ using AWS EKS, Terraform, ArgoCD, and FFmpeg</b>
</p>
