import { supabaseAdmin } from "../config/supabase";

const AVATAR_BUCKET = "avatars";

export async function getOnboardingCompleted(userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("onboarding_completed")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[profile] failed to read onboarding status", error.message);
    return false;
  }

  if (!data) {
    // Lazy-create for users who signed up before the profiles table existed.
    await supabaseAdmin.from("profiles").upsert({ user_id: userId }, { onConflict: "user_id" });
    return false;
  }

  return Boolean(data.onboarding_completed);
}

export async function markOnboardingCompleted(userId: string): Promise<void> {
  const { error } = await supabaseAdmin.from("profiles").upsert(
    {
      user_id: userId,
      onboarding_completed: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) {
    console.error("[profile] failed to mark onboarding complete", error.message);
    throw new Error(error.message);
  }
}

function extensionFromMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return map[mimeType] ?? "jpg";
}

/**
 * Uploads a new avatar image to Supabase Storage (overwriting any previous
 * one for this user, so nothing piles up), updates the user's
 * `avatar_url` metadata, and returns the updated auth user.
 */
export async function uploadAvatar(
  userId: string,
  file: { buffer: Buffer; mimetype: string }
) {
  const ext = extensionFromMimeType(file.mimetype);
  const path = `${userId}/avatar.${ext}`;

  const { error: uploadError } = await supabaseAdmin.storage
    .from(AVATAR_BUCKET)
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: true });

  if (uploadError) {
    throw new Error(uploadError.message);
  }

  const { data: publicUrlData } = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  // Cache-bust so the browser picks up the new image immediately even
  // though the path itself didn't change.
  const avatarUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;

  const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (userError || !userData?.user) {
    throw new Error(userError?.message || "User not found");
  }

  const existingMeta = (userData.user.user_metadata ?? {}) as Record<string, unknown>;

  const { data: updated, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: {
      ...existingMeta,
      avatar_url: avatarUrl,
    },
  });

  if (updateError || !updated.user) {
    throw new Error(updateError?.message || "Failed to update profile photo");
  }

  return updated.user;
}

/** Removes the user's avatar file from storage and clears their avatar_url metadata. */
export async function deleteAvatar(userId: string) {
  const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (userError || !userData?.user) {
    throw new Error(userError?.message || "User not found");
  }

  const existingMeta = (userData.user.user_metadata ?? {}) as Record<string, unknown>;

  // Best-effort cleanup — try the common extensions since we don't store which one was used.
  const candidates = ["jpg", "png", "gif", "webp"].map((ext) => `${userId}/avatar.${ext}`);
  await supabaseAdmin.storage.from(AVATAR_BUCKET).remove(candidates);

  const { data: updated, error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: {
      ...existingMeta,
      avatar_url: null,
    },
  });

  if (updateError || !updated.user) {
    throw new Error(updateError?.message || "Failed to remove profile photo");
  }

  return updated.user;
}
