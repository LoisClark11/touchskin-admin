// Supabase project credentials.
//
// 1. In the Supabase dashboard go to Project Settings > API
// 2. Copy the Project URL into SUPABASE_URL
// 3. The publishable key is already filled in below
//
// Key naming changed in newer projects:
//   older projects -> "anon public"       (starts with eyJ...)
//   newer projects -> "Publishable key"   (starts with sb_publishable_...)
// This is a Publishable key, which is designed to be public and is safe to
// ship in a browser -- Row Level Security in Postgres is what actually
// protects your data.
//
// Never put the service_role / Secret key (sb_secret_...) in this file. It
// bypasses RLS entirely and belongs only in server-side code.

export const SUPABASE_URL = "https://twuududkiejomeyskpnw.supabase.co";

export const SUPABASE_ANON_KEY = "sb_publishable_1qZIq8fVvT2lVpvKV8DDeA_5pi_2oik";
