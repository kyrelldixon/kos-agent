const DEFAULT_INNGEST_EVENT_URL = "http://localhost:8288/e/key";

export function generateRunScript(jobName: string): string {
  const escapedName = jobName.replace(/"/g, '\\"');
  return `#!/bin/bash
set -e
curl -sf -X POST "\${INNGEST_EVENT_URL:-${DEFAULT_INNGEST_EVENT_URL}}" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"agent.job.triggered","data":{"job":"${escapedName}"}}'
`;
}
