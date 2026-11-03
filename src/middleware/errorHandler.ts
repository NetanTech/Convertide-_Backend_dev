import type { NextFunction, Request, RequestHandler, Response } from "express";

// Wraps an async route handler so rejected promises reach the error middleware
// instead of crashing the process or hanging the request.
export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
}

function isBodyParseError(err: unknown): boolean {
  const e = err as {
    type?: string;
    status?: number;
    statusCode?: number;
    message?: string;
  } | null;
  if (!e) return false;
  if (e.type === "entity.parse.failed") return true;
  const status = e.status ?? e.statusCode;
  if (status === 400 && err instanceof SyntaxError) return true;
  const message = String(e.message ?? "");
  return (
    status === 400 &&
    /JSON|Unexpected token|Expected property|is not valid JSON|Unexpected end of JSON/i.test(message)
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function globalErrorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  console.error("[error]", err);

  if (isBodyParseError(err)) {
    return res.status(400).json({
      success: false,
      message: "Invalid request body",
    });
  }

  const status = err?.status ?? err?.statusCode ?? 500;
  res.status(status).json({
    success: false,
    message: err?.message || "Internal server error",
  });
}
