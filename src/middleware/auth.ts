import type { NextFunction, Request, Response } from "express";
import type { User } from "@supabase/supabase-js";
import { supabase } from "../config/supabase";

export interface AuthRequest extends Request {
  user?: User;
  accessToken?: string;
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

// Verifies the Supabase access token on every protected request. No session
// state lives on this server - the token itself is the source of truth.
export async function authenticateToken(req: AuthRequest, res: Response, next: NextFunction) {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ success: false, message: "Access token required" });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }

  req.user = data.user;
  req.accessToken = token;
  next();
}

// Attaches req.user when a valid token is present, but never blocks the request.
export async function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) return next();

  const { data } = await supabase.auth.getUser(token);
  if (data.user) {
    req.user = data.user;
    req.accessToken = token;
  }
  next();
}
