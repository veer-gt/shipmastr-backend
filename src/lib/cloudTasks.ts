import { env } from "../config/env.js";
import { HttpError } from "./httpError.js";

type FetchLike = typeof fetch;

type CloudTaskConfig = {
  projectId: string;
  location: string;
  queueName: string;
  handlerUrl: string;
  taskSecret: string;
};

type CreateCloudTaskInput = {
  taskId: string;
  payload: Record<string, unknown>;
};

type CreateCloudTaskDeps = {
  fetch?: FetchLike;
  getAccessToken?: () => Promise<string>;
};

function configured(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function getCloudTaskConfig(): CloudTaskConfig {
  const projectId = env.GCP_PROJECT_ID?.trim();
  const location = env.CLOUD_TASKS_LOCATION.trim();
  const queueName = env.EMAIL_QUEUE_NAME.trim();
  const handlerUrl = env.TASK_HANDLER_URL?.trim();
  const taskSecret = env.WEBHOOK_SECRET.trim();

  if (!projectId || !location || !queueName || !handlerUrl || !taskSecret) {
    throw new HttpError(503, "CLOUD_TASKS_NOT_CONFIGURED", {
      gcpProjectConfigured: configured(projectId),
      cloudTasksLocationConfigured: configured(location),
      emailQueueNameConfigured: configured(queueName),
      taskHandlerUrlConfigured: configured(handlerUrl),
      taskSecretConfigured: configured(taskSecret)
    });
  }

  return {
    projectId,
    location,
    queueName,
    handlerUrl,
    taskSecret
  };
}

function taskIdSafe(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 500);
}

async function getMetadataAccessToken(fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {
      headers: {
        "Metadata-Flavor": "Google"
      }
    }
  );

  if (!response.ok) {
    throw new HttpError(502, "CLOUD_TASKS_TOKEN_UNAVAILABLE");
  }

  const body = await response.json() as { access_token?: string };
  if (!body.access_token) {
    throw new HttpError(502, "CLOUD_TASKS_TOKEN_UNAVAILABLE");
  }

  return body.access_token;
}

export async function createEmailCloudTask(input: CreateCloudTaskInput, deps: CreateCloudTaskDeps = {}) {
  const config = getCloudTaskConfig();
  const fetchImpl = deps.fetch ?? fetch;
  const accessToken = deps.getAccessToken ? await deps.getAccessToken() : await getMetadataAccessToken(fetchImpl);
  const parent = `projects/${config.projectId}/locations/${config.location}/queues/${config.queueName}`;
  const taskName = `${parent}/tasks/${taskIdSafe(input.taskId)}`;
  const payload = JSON.stringify(input.payload);

  const response = await fetchImpl(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      task: {
        name: taskName,
        httpRequest: {
          httpMethod: "POST",
          url: config.handlerUrl,
          headers: {
            "Content-Type": "application/json",
            "x-shipmastr-task-secret": config.taskSecret
          },
          body: Buffer.from(payload, "utf8").toString("base64")
        }
      }
    })
  });

  if (response.status === 409) {
    return {
      ok: true,
      status: "already_exists" as const,
      taskName
    };
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new HttpError(502, "CLOUD_TASKS_ENQUEUE_FAILED", {
      status: response.status,
      error: errorText.slice(0, 240)
    });
  }

  const body = await response.json().catch(() => ({})) as { name?: string };
  return {
    ok: true,
    status: "created" as const,
    taskName: body.name || taskName
  };
}
