export async function writeTrackingResult(supabase, loadId, patch) {
  const { data, error } = await supabase
    .from("loads")
    .update(patch)
    .eq("id", loadId)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("Could not save tracking result:", error.code, error.message);
    throw new Error(
      `Could not save tracking result${error.code ? ` (database error ${error.code})` : ""}. Check server logs and database schema.`
    );
  }
  if (!data) throw new Error("Could not save tracking result: the load no longer exists.");
}
