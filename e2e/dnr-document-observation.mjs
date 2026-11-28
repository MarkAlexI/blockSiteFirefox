// Firefox 128 may destroy the old BiDi frame actor while native DNR is
// replacing about:blank. Continue only this read-only observation within its
// existing deadline; script errors and all other protocol failures still fail.
export async function readDnrDocument(read) {
  try { return await read(); }
  catch (error) {
    if (error?.message === "script.evaluate: unknown error: AbortError: Actor 'MessageHandlerFrame' destroyed before query 'MessageHandlerFrameParent:sendCommand' was resolved") return null;
    throw error;
  }
}
