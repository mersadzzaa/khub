import { createClient } from "@supabase/supabase-js";

// ------------------------------------------------------------------
// اطلاعات Supabase خود را در اینجا جایگزین کنید
// به داشبورد Supabase بروید -> Settings -> API
// ------------------------------------------------------------------
const SUPABASE_URL = "https://xnhtfdcqzhrmxipgizoq.supabase.co";
const SUPABASE_ANON_KEY = "api";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
