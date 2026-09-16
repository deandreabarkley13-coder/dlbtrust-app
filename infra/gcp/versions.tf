terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State lives in the bucket created by scripts/gcp/bootstrap.sh; pass it with
  #   terraform init -backend-config="bucket=<project>-tfstate"
  backend "gcs" {
    prefix = "dlbtrust-app"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
