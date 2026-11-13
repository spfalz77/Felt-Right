// ════════════════════════════════════════════════════════════════════════════
// CONFIG — Replace with your Supabase project values
// ════════════════════════════════════════════════════════════════════════════
const SUPABASE_URL     = 'https://dcfsbtefwkcbdeqreiyx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjZnNidGVmd2tjYmRlcXJlaXl4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4Njc0MjcsImV4cCI6MjA5MjQ0MzQyN30.yTf3TCkZvDYZOpHC-2KOIvavzgnG__s6FzrGP5e3HTU';


// The public web address. Links people share (invites, password reset) always
// point here, because inside the Android/iPhone app the page's own address is
// https://localhost.
const PUBLIC_APP_URL = 'https://spfalz77.github.io/Felt-Right/';
const IS_NATIVE_APP = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
function appBaseUrl() {
  return IS_NATIVE_APP ? PUBLIC_APP_URL : location.origin + location.pathname;
}
