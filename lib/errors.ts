// Supabase errors are plain objects, not Error instances.
export function failureMessage(failure: unknown) {
  return failure && typeof failure === "object" && "message" in failure && typeof failure.message === "string"
    ? failure.message
    : "Please try again.";
}
