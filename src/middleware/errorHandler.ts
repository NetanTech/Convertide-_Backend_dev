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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function globalErrorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  console.error("[error]", err);
  const status = err?.status ?? 500;
  res.status(status).json({
    success: false,
    message: err?.message || "Internal server error",
  });
}
