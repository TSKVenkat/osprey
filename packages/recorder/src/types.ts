/** Mirrors the capability record the API returns when a recording is created. */
export interface Capabilities {
  directUpload: boolean;
  multipart: boolean;
  resumable: boolean;
  signedRead: boolean;
  rangeRequests: boolean;
  serverSideTranscode: boolean;
  adaptiveStreaming: boolean;
  minPartBytes: number;
  maxPartBytes: number;
  maxObjectBytes: number;
  partAlignmentBytes?: number;
}

export interface UploadSessionInfo {
  recordingId: string;
  uploadSessionId: string;
  partSize: number;
  capabilities: Capabilities;
}

/**
 * How many parts to have in flight. Only backends that accept parts in parallel get
 * more than one; the rest have to be fed in order.
 */
export function concurrencyFor(capabilities: Capabilities): number {
  return capabilities.multipart ? 4 : 1;
}
