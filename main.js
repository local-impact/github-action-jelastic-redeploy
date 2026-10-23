import * as core from '@actions/core';
import axios from 'axios';

async function main() {
  const jelasticUrl = core.getInput('jelastic_url');
  const jelasticToken = core.getInput('jelastic_token');
  const envName = core.getInput('jelastic_env');
  const version = core.getInput('version');
  const deployDelay = core.getInput('deploy_delay');
  const requestTimeout = Number(core.getInput('request_timeout'));
  const healthCheckPath = core.getInput('health_check_path');

  const jelastic = jelasticClient(jelasticUrl, jelasticToken, requestTimeout, envName);

  if (healthCheckPath) {
    const healthCheck = {
      path: healthCheckPath,
      timeout: Number(core.getInput('health_check_timeout')) * 1000,
      interval: Number(core.getInput('health_check_interval')) * 1000,
    };

    core.info(`Deploying ${envName} on ${jelasticUrl} to version ${version} (with health check)`);

    await redeployWithHealthCheck(jelastic, version, healthCheck);
  } else {
    core.info(`Deploying ${envName} on ${jelasticUrl} to version ${version} (delay=${deployDelay})`);

    await redeployWithDelay(jelastic, version, deployDelay);
  }
}

// Calls a method of the Jelastic environment.control API. The session goes in
// the request body, so that it does not end up in logged URLs.
function jelasticClient(jelasticUrl, jelasticToken, requestTimeout, envName) {
  const client = axios.create({ timeout: requestTimeout, responseType: 'json' });

  return async (method, params) => {
    const body = new URLSearchParams({ session: jelasticToken, envName, ...params });
    const response = await client.post(
      `https://${jelasticUrl}/1.0/environment/control/rest/${method}`,
      body,
    );

    return response.data;
  };
}

// Redeploys the containers of the cp node group one by one, waiting a fixed
// delay between two containers.
async function redeployWithDelay(jelastic, version, deployDelay) {
  const response = await jelastic('redeploycontainersbygroup', {
    tag: version,
    nodeGroup: 'cp',
    isSequential: true,
    delay: deployDelay,
  });

  core.setOutput('response', response);

  if (response?.result !== 0) {
    throw new Error(`Could not deploy: ${response?.error}`);
  }
}

// Redeploys the containers of the cp node group one by one, and waits for each
// one to pass the health check before redeploying the next, instead of waiting
// a fixed delay.
async function redeployWithHealthCheck(jelastic, version, healthCheck) {
  const envInfo = await jelastic('getenvinfo', {});
  if (envInfo.result !== 0) {
    throw new Error(`Could not get the environment info: ${envInfo.error}`);
  }

  const nodes = envInfo.nodes.filter((node) => node.nodeGroup === 'cp');
  core.info(`Containers to redeploy: ${nodes.map((node) => node.id).join(', ')}`);

  const responses = [];

  for (const node of nodes) {
    const start = Date.now();

    core.info(`Redeploying container ${node.id}`);
    const response = await jelastic('redeploycontainerbyid', { nodeId: node.id, tag: version });
    if (response.result !== 0) {
      throw new Error(`Could not redeploy container ${node.id}: ${response.error}`);
    }
    responses.push(response);
    core.info(`Container ${node.id} redeployed in ${seconds(Date.now() - start)}`);

    await waitUntilHealthy(node, healthCheck);
    core.info(`Container ${node.id} healthy ${seconds(Date.now() - start)} after the redeploy started`);
  }

  core.setOutput('response', { result: 0, responses });
}

// Requests the health check path on the container's own URL. That URL reaches
// the container through the same port as the environment's load balancer, so
// the container passes once the load balancer can actually serve it, which
// can be minutes after the application inside it is up.
async function waitUntilHealthy(node, { path, timeout, interval }) {
  const url = new URL(path, node.url);
  const deadline = Date.now() + timeout;

  for (;;) {
    // Timeouts, errors and throttling (429) all just mean "not healthy yet".
    const status = await axios
      .get(url.href, { timeout: 5000, maxRedirects: 0, validateStatus: () => true })
      .then((response) => response.status, (error) => error.code ?? error.message);

    if (status >= 200 && status < 300) {
      return;
    }

    if (Date.now() + interval > deadline) {
      throw new Error(`Container ${node.id} is not healthy after ${seconds(timeout)}: ${url.href} answered ${status}`);
    }

    core.info(`Container ${node.id} not healthy yet (${url.href} answered ${status})`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const seconds = (ms) => `${Math.round(ms / 1000)}s`;

main()
  .catch((error) => core.setFailed(error.message));
