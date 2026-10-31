/**
 * The deterministic code-mode investigation used by the recovery tests.
 *
 * The child process and the resuming test must run the exact same script:
 * the durable code-mode tool compares a fingerprint of the script when it
 * reruns it after a restart.
 */
export const recoveryScript = `
const status = await tools.mcp__frigate__get_system_status({});
if (status.isError || !status.structuredContent.ok) throw new Error('Status failed');
const cameras = await tools.mcp__frigate__list_cameras({});
if (cameras.isError || !cameras.structuredContent.ok) throw new Error('Discovery failed');
text({
  observedAt: status.structuredContent.meta.observedAt,
  authorizedApiAccess: status.structuredContent.data.authorizedApiAccess,
  cameras: cameras.structuredContent.data.cameras.length,
  complete: status.structuredContent.data.statistics.ok,
});
`;
