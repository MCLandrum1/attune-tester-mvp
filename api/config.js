export default function handler(_request, response) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    return response.status(503).json({
      configured: false,
      message: "Cloud sync is not configured.",
    });
  }

  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json({
    configured: true,
    supabaseUrl,
    supabasePublishableKey,
  });
}
