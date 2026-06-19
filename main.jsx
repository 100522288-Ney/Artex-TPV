import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://kasmnxmslubnbayatsts.supabase.co';
const SUPABASE_KEY = 'sb_publishable_7BadeuJUb9njt0ajpJWT1A_Vo5my01P';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
