import { createClient } from "@supabase/supabase-js";

// ------------------------------------------------------------------
// اطلاعات Supabase خود را در اینجا جایگزین کنید
// به داشبورد Supabase بروید -> Settings -> API
// ------------------------------------------------------------------
const SUPABASE_URL = "https://xnhtfdcqzhrmxipgizoq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_4Qolzb9gVF_50MyLIz2KfQ_6w9yJkZ0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

