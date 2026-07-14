-- SUPABASE DATABASE SCHEMA
-- This schema represents the full database structure migrated from Firebase.

-- 1. Rules / Knowledge Base
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  question TEXT NOT NULL,
  keywords TEXT NOT NULL,
  synonyms TEXT,
  answer TEXT NOT NULL,
  related_department TEXT,
  priority INTEGER DEFAULT 1,
  status TEXT DEFAULT 'Active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Departments
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_number TEXT,
  email TEXT,
  location TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Categories
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. Faculty
CREATE TABLE IF NOT EXISTS faculty (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  designation TEXT,
  department TEXT,
  email TEXT,
  contact TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. Support Tickets
CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  student_name TEXT,
  email TEXT NOT NULL,
  country_code TEXT,
  phone TEXT,
  role TEXT,
  query TEXT NOT NULL,
  status TEXT DEFAULT 'Open',
  admin_response TEXT,
  responded_at TIMESTAMP WITH TIME ZONE,
  notification_channels JSONB,
  user_notified BOOLEAN DEFAULT FALSE,
  chat_session_id TEXT,
  conversation_id TEXT,
  language TEXT,
  user_id UUID REFERENCES auth.users(id),
  current_page TEXT,
  website_section TEXT
);

-- 6. Notices / Calendar
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  "desc" TEXT,
  type TEXT,
  image_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 7. Portal Links
CREATE TABLE IF NOT EXISTS portal_links (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 8. Chat Logs / Conversations
CREATE TABLE IF NOT EXISTS chat_logs (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
  user_query TEXT NOT NULL,
  matched_rule_id TEXT,
  matched_question TEXT,
  score FLOAT DEFAULT 0,
  user_role TEXT,
  fallback_triggered BOOLEAN DEFAULT FALSE,
  user_id UUID REFERENCES auth.users(id)
);

-- 9. Website Knowledge Settings
CREATE TABLE IF NOT EXISTS website_knowledge_settings (
  id TEXT PRIMARY KEY DEFAULT 'main',
  supabase_url TEXT,
  supabase_key TEXT,
  domain TEXT,
  crawl_url TEXT,
  crawl_limit INTEGER DEFAULT 8,
  scheduled_interval_hours INTEGER DEFAULT 24,
  is_scheduled_sync BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 10. Website Indexed Content (Crawler Results)
CREATE TABLE IF NOT EXISTS website_indexed_content (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  domain TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  content TEXT NOT NULL,
  last_indexed TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 11. Feedback
CREATE TABLE IF NOT EXISTS feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 12. User Profiles (Extending auth.users)
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  full_name TEXT,
  role TEXT DEFAULT 'Student',
  is_admin BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- RLS POLICIES (Example for rules table)
ALTER TABLE rules ENABLE ROW LEVEL SECURITY;

-- Allow public read access to rules
CREATE POLICY "Rules are viewable by everyone" 
ON rules FOR SELECT 
USING (true);

-- Allow admins to manage rules
CREATE POLICY "Admins can manage rules" 
ON rules FOR ALL 
USING (
  EXISTS (
    SELECT 1 FROM user_profiles 
    WHERE user_profiles.id = auth.uid() 
    AND user_profiles.is_admin = true
  )
);

-- (Apply similar policies to other tables based on your security requirements)

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_chat_logs_timestamp ON chat_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_rules_category ON rules(category);
CREATE INDEX IF NOT EXISTS idx_website_indexed_content_domain ON website_indexed_content(domain);
