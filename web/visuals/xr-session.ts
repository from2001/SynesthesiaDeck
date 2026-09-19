export const MR_EXIT_TIMEOUT_MS = 5000;

interface SessionHandle { end(): Promise<void> }
interface SessionManager {
  isPresenting: boolean;
  getSession(): SessionHandle | null;
}

/** Resolve the session from the same manager that supplies the UI's presenting state. */
export async function endActiveMRSession(
  manager: SessionManager,
  cachedSession: SessionHandle | null,
  report: (message: string) => void,
): Promise<void> {
  const session = manager.getSession() ?? cachedSession;
  if (!session) {
    if (manager.isPresenting) throw new Error('MR is presenting, but no active XR session handle is available. Use the headset system controls to leave MR.');
    return;
  }
  report('Exiting MR...');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.end(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MR exit is still pending in the browser after 5 seconds. Use the headset system controls to leave MR.')), MR_EXIT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  // Only the real sessionend event may clear renderer state and restore desktop rendering.
}
