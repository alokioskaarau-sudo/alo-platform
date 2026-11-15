--
-- PostgreSQL database dump
--

\restrict 7oTg3KqSOU5ggVrQxP4F7rpVXM7hSPidyrtDa2wq3b2DvXXFDTcp64oDLlyUvJ8

-- Dumped from database version 17.11 (Homebrew)
-- Dumped by pg_dump version 17.11 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: alo_now_address_verifications_v336; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alo_now_address_verifications_v336 (
    request_id uuid NOT NULL,
    verified_address text NOT NULL,
    verified_by text NOT NULL,
    verification_source text NOT NULL,
    verified_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alo_now_address_verifications_v336_verification_source_check CHECK ((verification_source = ANY (ARRAY['SWISS_POST'::text, 'MANUAL_STAFF'::text]))),
    CONSTRAINT alo_now_address_verifications_v336_verified_address_check CHECK (((length(btrim(verified_address)) >= 8) AND (length(btrim(verified_address)) <= 500))),
    CONSTRAINT alo_now_address_verifications_v336_verified_by_check CHECK (((length(btrim(verified_by)) >= 1) AND (length(btrim(verified_by)) <= 150)))
);


--
-- Name: alo_now_checkout_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alo_now_checkout_intents (
    request_id uuid NOT NULL,
    checkout_reference uuid NOT NULL,
    shopify_order_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alo_now_checkout_order_gid CHECK (((shopify_order_id IS NULL) OR (shopify_order_id ~ '^gid://shopify/Order/[1-9][0-9]*$'::text)))
);


--
-- Name: alo_now_draft_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alo_now_draft_operations (
    request_id uuid NOT NULL,
    checkout_reference uuid NOT NULL,
    status text DEFAULT 'PREPARED'::text NOT NULL,
    expected_total_chf numeric(12,2) NOT NULL,
    attempt_id uuid,
    draft_order_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alo_now_draft_id_format_v318 CHECK (((draft_order_id IS NULL) OR (draft_order_id ~ '^gid://shopify/DraftOrder/[1-9][0-9]*$'::text))),
    CONSTRAINT alo_now_draft_operations_expected_total_chf_check CHECK ((expected_total_chf > (0)::numeric)),
    CONSTRAINT alo_now_draft_operations_status_check CHECK ((status = ANY (ARRAY['PREPARED'::text, 'CREATING'::text, 'CREATED'::text, 'RECONCILE_REQUIRED'::text]))),
    CONSTRAINT alo_now_draft_status_fields_v318 CHECK ((((status = 'PREPARED'::text) AND (attempt_id IS NULL) AND (draft_order_id IS NULL)) OR ((status = 'CREATING'::text) AND (attempt_id IS NOT NULL) AND (draft_order_id IS NULL)) OR ((status = 'RECONCILE_REQUIRED'::text) AND (attempt_id IS NOT NULL)) OR ((status = 'CREATED'::text) AND (attempt_id IS NOT NULL) AND (draft_order_id IS NOT NULL))))
);


--
-- Name: alo_now_merchant_acceptances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alo_now_merchant_acceptances (
    request_id uuid NOT NULL,
    fulfillment_method text NOT NULL,
    accepted_by text NOT NULL,
    assigned_driver_id text,
    capacity_confirmed_at timestamp with time zone DEFAULT now() NOT NULL,
    capacity_confirmed_until timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alo_now_merchant_acceptances_accepted_by_check CHECK (((length(btrim(accepted_by)) >= 1) AND (length(btrim(accepted_by)) <= 150))),
    CONSTRAINT alo_now_merchant_acceptances_fulfillment_method_check CHECK ((fulfillment_method = ANY (ARRAY['INTERNAL_DELIVERY'::text, 'ASSIGNED_DRIVER'::text]))),
    CONSTRAINT alo_now_merchant_capacity_window_v329 CHECK ((capacity_confirmed_until > capacity_confirmed_at)),
    CONSTRAINT alo_now_merchant_method_v329 CHECK ((((fulfillment_method = 'INTERNAL_DELIVERY'::text) AND (assigned_driver_id IS NULL)) OR ((fulfillment_method = 'ASSIGNED_DRIVER'::text) AND (assigned_driver_id IS NOT NULL) AND (length(btrim(assigned_driver_id)) > 0))))
);


--
-- Name: TABLE alo_now_merchant_acceptances; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.alo_now_merchant_acceptances IS 'V329: internal staff-authorized delivery commitment; not a customer checkout or payment authorization.';


--
-- Name: alo_now_payment_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alo_now_payment_events (
    id uuid NOT NULL,
    payment_state_id uuid NOT NULL,
    event_type text NOT NULL,
    previous_phase text NOT NULL,
    next_phase text NOT NULL,
    actor_type text NOT NULL,
    actor_id text,
    source_reference text,
    resulting_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alo_now_payment_events_actor_type_check CHECK ((actor_type = ANY (ARRAY['DRIVER'::text, 'ADMIN'::text, 'CUSTOMER'::text, 'SYSTEM'::text, 'SHOPIFY'::text]))),
    CONSTRAINT alo_now_payment_events_event_type_check CHECK ((event_type = ANY (ARRAY['DRIVER_ACCEPTED'::text, 'ONLINE_PAYMENT_REQUESTED'::text, 'ONLINE_PAYMENT_VERIFIED'::text, 'CASH_AGREEMENT_VERIFIED'::text, 'RESERVATION_EXPIRED'::text, 'CANCELLED'::text, 'MERCHANT_PAYMENT_AUTHORIZED'::text]))),
    CONSTRAINT alo_now_payment_events_resulting_version_check CHECK ((resulting_version >= 2))
);


--
-- Name: alo_now_payment_reconciliations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alo_now_payment_reconciliations (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    shopify_order_id text NOT NULL,
    expected_total_chf numeric(12,2) NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'OPEN'::text NOT NULL,
    first_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_detected_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolution_note text,
    CONSTRAINT alo_now_payment_reconciliations_expected_total_chf_check CHECK ((expected_total_chf > (0)::numeric)),
    CONSTRAINT alo_now_payment_reconciliations_reason_check CHECK ((reason = 'RESERVATION_EXPIRED'::text)),
    CONSTRAINT alo_now_payment_reconciliations_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'IN_REVIEW'::text, 'RESOLVED'::text])))
);


--
-- Name: alo_now_payment_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alo_now_payment_states (
    id uuid NOT NULL,
    request_id uuid NOT NULL,
    shopify_order_id text,
    phase text DEFAULT 'AWAITING_DRIVER'::text NOT NULL,
    payment_method text,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alo_now_payment_states_check CHECK ((((phase = ANY (ARRAY['AWAITING_DRIVER'::text, 'DRIVER_ACCEPTED'::text])) AND (payment_method IS NULL)) OR ((phase = 'AWAITING_PAYMENT'::text) AND (payment_method = 'ONLINE'::text)) OR ((phase = 'PAYMENT_CONFIRMED'::text) AND (payment_method = 'ONLINE'::text)) OR ((phase = 'CASH_CONFIRMED'::text) AND (payment_method = 'CASH'::text)) OR (phase = ANY (ARRAY['EXPIRED'::text, 'CANCELLED'::text])))),
    CONSTRAINT alo_now_payment_states_payment_method_check CHECK (((payment_method IS NULL) OR (payment_method = ANY (ARRAY['ONLINE'::text, 'CASH'::text])))),
    CONSTRAINT alo_now_payment_states_phase_check CHECK ((phase = ANY (ARRAY['AWAITING_DRIVER'::text, 'DRIVER_ACCEPTED'::text, 'AWAITING_PAYMENT'::text, 'PAYMENT_CONFIRMED'::text, 'CASH_CONFIRMED'::text, 'EXPIRED'::text, 'CANCELLED'::text]))),
    CONSTRAINT alo_now_payment_states_version_check CHECK ((version >= 1))
);


--
-- Name: alo_now_address_verifications_v336 alo_now_address_verifications_v336_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_address_verifications_v336
    ADD CONSTRAINT alo_now_address_verifications_v336_pkey PRIMARY KEY (request_id);


--
-- Name: alo_now_checkout_intents alo_now_checkout_intents_checkout_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_checkout_intents
    ADD CONSTRAINT alo_now_checkout_intents_checkout_reference_key UNIQUE (checkout_reference);


--
-- Name: alo_now_checkout_intents alo_now_checkout_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_checkout_intents
    ADD CONSTRAINT alo_now_checkout_intents_pkey PRIMARY KEY (request_id);


--
-- Name: alo_now_checkout_intents alo_now_checkout_intents_shopify_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_checkout_intents
    ADD CONSTRAINT alo_now_checkout_intents_shopify_order_id_key UNIQUE (shopify_order_id);


--
-- Name: alo_now_draft_operations alo_now_draft_operations_attempt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_draft_operations
    ADD CONSTRAINT alo_now_draft_operations_attempt_id_key UNIQUE (attempt_id);


--
-- Name: alo_now_draft_operations alo_now_draft_operations_draft_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_draft_operations
    ADD CONSTRAINT alo_now_draft_operations_draft_order_id_key UNIQUE (draft_order_id);


--
-- Name: alo_now_draft_operations alo_now_draft_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_draft_operations
    ADD CONSTRAINT alo_now_draft_operations_pkey PRIMARY KEY (request_id);


--
-- Name: alo_now_merchant_acceptances alo_now_merchant_acceptances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_merchant_acceptances
    ADD CONSTRAINT alo_now_merchant_acceptances_pkey PRIMARY KEY (request_id);


--
-- Name: alo_now_payment_events alo_now_payment_events_payment_state_id_resulting_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_payment_events
    ADD CONSTRAINT alo_now_payment_events_payment_state_id_resulting_version_key UNIQUE (payment_state_id, resulting_version);


--
-- Name: alo_now_payment_events alo_now_payment_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_payment_events
    ADD CONSTRAINT alo_now_payment_events_pkey PRIMARY KEY (id);


--
-- Name: alo_now_payment_reconciliations alo_now_payment_reconciliations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_payment_reconciliations
    ADD CONSTRAINT alo_now_payment_reconciliations_pkey PRIMARY KEY (id);


--
-- Name: alo_now_payment_states alo_now_payment_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_payment_states
    ADD CONSTRAINT alo_now_payment_states_pkey PRIMARY KEY (id);


--
-- Name: alo_now_payment_states alo_now_payment_states_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_payment_states
    ADD CONSTRAINT alo_now_payment_states_request_id_key UNIQUE (request_id);


--
-- Name: alo_now_payment_states alo_now_payment_states_shopify_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_payment_states
    ADD CONSTRAINT alo_now_payment_states_shopify_order_id_key UNIQUE (shopify_order_id);


--
-- Name: alo_now_payment_reconciliations alo_now_reconciliation_unique_order; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_payment_reconciliations
    ADD CONSTRAINT alo_now_reconciliation_unique_order UNIQUE (shopify_order_id);


--
-- Name: alo_now_payment_reconciliations alo_now_reconciliation_unique_request_order; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_payment_reconciliations
    ADD CONSTRAINT alo_now_reconciliation_unique_request_order UNIQUE (request_id, shopify_order_id);


--
-- Name: alo_now_intent_identity_v318; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX alo_now_intent_identity_v318 ON public.alo_now_checkout_intents USING btree (request_id, checkout_reference);


--
-- Name: alo_now_payment_events_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alo_now_payment_events_state_idx ON public.alo_now_payment_events USING btree (payment_state_id, created_at);


--
-- Name: alo_now_payment_states_shopify_order_id_unique_v310; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX alo_now_payment_states_shopify_order_id_unique_v310 ON public.alo_now_payment_states USING btree (shopify_order_id) WHERE (shopify_order_id IS NOT NULL);


--
-- Name: alo_now_reconciliation_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX alo_now_reconciliation_status_idx ON public.alo_now_payment_reconciliations USING btree (status, first_detected_at);


--
-- Name: alo_now_draft_operations alo_now_draft_transition_guard_v318; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER alo_now_draft_transition_guard_v318 BEFORE INSERT OR UPDATE ON public.alo_now_draft_operations FOR EACH ROW EXECUTE FUNCTION public.alo_now_draft_transition_v318();


--
-- Name: alo_now_checkout_intents alo_now_intent_cross_guard_v311; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER alo_now_intent_cross_guard_v311 BEFORE INSERT OR UPDATE OF shopify_order_id, request_id ON public.alo_now_checkout_intents FOR EACH ROW EXECUTE FUNCTION public.alo_now_cross_table_order_guard_v311();


--
-- Name: alo_now_payment_states alo_now_payment_cross_guard_v311; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER alo_now_payment_cross_guard_v311 BEFORE INSERT OR UPDATE OF shopify_order_id, request_id ON public.alo_now_payment_states FOR EACH ROW EXECUTE FUNCTION public.alo_now_cross_table_order_guard_v311();


--
-- Name: alo_now_address_verifications_v336 alo_now_address_verifications_v336_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_address_verifications_v336
    ADD CONSTRAINT alo_now_address_verifications_v336_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.alo_now_order_requests(id) ON DELETE RESTRICT;


--
-- Name: alo_now_checkout_intents alo_now_checkout_intents_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_checkout_intents
    ADD CONSTRAINT alo_now_checkout_intents_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.alo_now_order_requests(id) ON DELETE RESTRICT;


--
-- Name: alo_now_draft_operations alo_now_draft_intent_fk_v318; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_draft_operations
    ADD CONSTRAINT alo_now_draft_intent_fk_v318 FOREIGN KEY (request_id, checkout_reference) REFERENCES public.alo_now_checkout_intents(request_id, checkout_reference);


--
-- Name: alo_now_merchant_acceptances alo_now_merchant_acceptances_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_merchant_acceptances
    ADD CONSTRAINT alo_now_merchant_acceptances_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.alo_now_order_requests(id) ON DELETE RESTRICT;


--
-- Name: alo_now_payment_events alo_now_payment_events_payment_state_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_payment_events
    ADD CONSTRAINT alo_now_payment_events_payment_state_id_fkey FOREIGN KEY (payment_state_id) REFERENCES public.alo_now_payment_states(id) ON DELETE RESTRICT;


--
-- Name: alo_now_payment_reconciliations alo_now_payment_reconciliations_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_payment_reconciliations
    ADD CONSTRAINT alo_now_payment_reconciliations_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.alo_now_order_requests(id);


--
-- Name: alo_now_payment_states alo_now_payment_states_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alo_now_payment_states
    ADD CONSTRAINT alo_now_payment_states_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.alo_now_order_requests(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict 7oTg3KqSOU5ggVrQxP4F7rpVXM7hSPidyrtDa2wq3b2DvXXFDTcp64oDLlyUvJ8
