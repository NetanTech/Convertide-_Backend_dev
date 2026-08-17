import { supabaseAdmin } from "../config/supabase";

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
