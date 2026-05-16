-- ============================================================
--  VOXIRO — Agent Sessions Schema Addition
--  Run AFTER voxiro_schema.sql and voxiro_admin_schema.sql
--  Tracks one Managed Agent session per customer per business
-- ============================================================

CREATE TABLE agent_sessions (
  id                   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id          UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone       VARCHAR(30) NOT NULL,
  anthropic_session_id TEXT,                          -- Managed Agent session ID from Anthropic
  status               VARCHAR(20) NOT NULL DEFAULT 'pending',
                                                      -- pending | active | terminated | expired
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, customer_phone)                 -- one active session per customer per business
);

COMMENT ON TABLE agent_sessions IS 'Tracks dedicated Managed Agent sessions — one per customer per business';

CREATE INDEX idx_agent_sessions_business_id    ON agent_sessions(business_id);
CREATE INDEX idx_agent_sessions_customer_phone ON agent_sessions(customer_phone);
CREATE INDEX idx_agent_sessions_status         ON agent_sessions(status);

CREATE TRIGGER trg_agent_sessions_updated_at
  BEFORE UPDATE ON agent_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
--  CUSTOMER PROFILES
--  Persistent memory across conversations — what the agent 
--  learned about each customer over time
-- ============================================================

CREATE TABLE customer_profiles (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone           VARCHAR(30) NOT NULL,
  name            VARCHAR(255),
  preferences     TEXT,                               -- "likes mornings, prefers cash"
  allergies       TEXT,                               -- health/safety critical info
  notes           TEXT,                               -- agent's observations
  visit_count     INTEGER     NOT NULL DEFAULT 0,
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, phone)
);

COMMENT ON TABLE customer_profiles IS 'Long-term memory per customer — built by agent across conversations';

CREATE INDEX idx_customer_profiles_business_id ON customer_profiles(business_id);
CREATE INDEX idx_customer_profiles_phone       ON customer_profiles(phone);

CREATE TRIGGER trg_customer_profiles_updated_at
  BEFORE UPDATE ON customer_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
