// Secure error handling — prevent internal message leakage

export function toClientError(err: unknown, requestId?: string): {
  success: false;
  error: string;
  code: string;
  statusCode: number;
  requestId?: string;
} {
  const isProd = process.env.NODE_ENV === 'production';

  if (err && typeof err === 'object' && 'statusCode' in err && 'code' in err && 'message' in err) {
    const e = err as { statusCode: number; code: string; message: string; isOperational?: boolean };
    if (e.isOperational !== false) {
      return {
        success: false,
        error: e.message,
        code: e.code,
        statusCode: e.statusCode,
        requestId,
      };
    }
  }

  return {
    success: false,
    error: isProd ? 'An unexpected error occurred' : (err instanceof Error ? err.message : 'Internal server error'),
    code: 'INTERNAL_ERROR',
    statusCode: 500,
    requestId,
  };
}
