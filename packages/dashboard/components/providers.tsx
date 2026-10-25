"use client";

import { useEffect, useState } from "react";
import { hubPost } from "./hub-client.ts";
import { usePoll } from "./use-poll.ts";
import { ActionButton, Badge, Banner, Section, TopBar } from "./ui.tsx";
import type { Models, Price, Provider, ProviderPreset } from "../lib/types.ts";
import { keyTravelsInClear, priceBody, providerBody, providerDetail, providerId, PROVIDER_FORMS } from "../lib/view.ts";

const PRESETS = Object.keys(PROVIDER_FORMS) as ProviderPreset[];

/** Where models come from: add a provider with its key (or a local server's address), remove one, and set prices. */
export function Providers() {
  const providers = usePoll<Provider[]>("providers", 30_000);
  const prices = usePoll<Price[]>("prices", 30_000);
  const models = usePoll<Models>("models", 30_000);

  return (
    <>
      <TopBar title="Model providers" back="/" />
      <main className="page">
        <p className="muted">
          Agents use the models these providers offer. Add one with its API key, or a local server with its address; the Hub
          then lists its models in each desk&apos;s model picker. Keys stay on the Hub and are never shown again.
        </p>
        {providers.error && <Banner tone="bad">{providers.error}</Banner>}

        <Section title="Providers" count={providers.data?.length}>
          {providers.data?.length === 0 && <p className="muted">No providers yet: add one below.</p>}
          <div className="card-list">
            {providers.data?.map((p) => {
              const { detail, badge } = providerDetail(p);
              return (
                <div key={p.id} className="row">
                  <div className="row-main">
                    <span className="row-title">
                      {p.label} <span className="muted small mono">{p.id}</span>
                    </span>
                    <span className="row-sub">{detail}</span>
                  </div>
                  <Badge label={badge.label} tone={badge.tone} />
                  {p.source === "added" && (
                    <ActionButton
                      label="Remove"
                      variant="danger"
                      confirm={`Remove ${p.label}? The Hub forgets its key, and desks on its models go back to the default.`}
                      run={async () => {
                        const r = await hubPost(`providers/${p.id}/remove`);
                        if (r.ok) providers.refresh();
                        return r.ok ? undefined : r.error;
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        <AddProvider taken={providers.data?.map((p) => p.id) ?? []} onAdded={() => { providers.refresh(); models.refresh(); }} />

        <Section title="Prices" count={prices.data?.length}>
          <p className="muted small">
            USD per million tokens. A model without a price counts as free, so task budgets don&apos;t stop it (the turn limit
            still does). OpenRouter reports its own prices.
          </p>
          <div className="card-list">
            {prices.data?.map((p) => (
              <div key={p.model} className="row">
                <div className="row-main">
                  <span className="row-title mono small">{p.model}</span>
                  <span className="row-sub">
                    ${p.input} in · ${p.output} out{p.source === "set" ? " · set here" : ""}
                  </span>
                </div>
                {p.source === "set" && (
                  <ActionButton
                    label="Remove"
                    variant="plain"
                    run={async () => {
                      const r = await hubPost("prices/remove", { model: p.model });
                      if (r.ok) prices.refresh();
                      return r.ok ? undefined : r.error;
                    }}
                  />
                )}
              </div>
            ))}
          </div>
          <SetPrice models={models.data?.available.map((m) => m.spec) ?? []} onSet={prices.refresh} />
        </Section>
      </main>
    </>
  );
}

/** The add form. The key field is a password field, cleared after sending. */
function AddProvider({ taken, onAdded }: { taken: string[]; onAdded: () => void }) {
  const [form, setForm] = useState({ preset: "anthropic" as ProviderPreset, key: "", url: "", name: "", vision: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [inClear, setInClear] = useState(false);
  useEffect(() => setInClear(keyTravelsInClear(window.location)), []);
  const info = PROVIDER_FORMS[form.preset];
  const replaces = taken.includes(providerId(form));

  const submit = async () => {
    const built = providerBody(form);
    if ("error" in built) return setError(built.error);
    setBusy(true);
    setError(undefined);
    const r = await hubPost<Provider>("providers", built.body);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setForm({ ...form, key: "", url: "", name: "", vision: false });
    onAdded();
  };

  return (
    <Section title="Add a provider">
      {inClear && (
        <Banner tone="waiting">
          This page isn&apos;t on HTTPS, so a key typed here crosses the network unencrypted. Open the console over HTTPS (e.g.
          Tailscale), or add the provider on the Hub machine: <code>aso provider add {form.preset}</code>.
        </Banner>
      )}
      <label className="field">
        <span className="field-label">Provider</span>
        <select className="input" value={form.preset} onChange={(e) => setForm({ ...form, preset: e.target.value as ProviderPreset })}>
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_FORMS[p].label}
            </option>
          ))}
        </select>
        {info.hint && <span className="muted small">{info.hint}</span>}
      </label>
      {info.url && (
        <label className="field">
          <span className="field-label">Address</span>
          <input className="input" type="url" value={form.url} placeholder="http://avalon:11434/v1" onChange={(e) => setForm({ ...form, url: e.target.value })} />
        </label>
      )}
      <label className="field">
        <span className="field-label">API key{info.key === "optional" ? " (if it needs one)" : ""}</span>
        <input
          className="input mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={form.key}
          onChange={(e) => setForm({ ...form, key: e.target.value })}
        />
      </label>
      <label className="field">
        <span className="field-label">Name on the Hub (optional)</span>
        <input className="input mono" value={form.name} placeholder={form.preset} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <span className="muted small">Models are named &lt;name&gt;/&lt;model&gt;. Give a second server of a kind its own name, e.g. ollama-lab.</span>
      </label>
      {info.vision && (
        <label className="checkbox small">
          <input type="checkbox" checked={form.vision} onChange={(e) => setForm({ ...form, vision: e.target.checked })} /> Its models accept images (QA
          screenshots)
        </label>
      )}
      {error && <Banner tone="bad">{error}</Banner>}
      <button type="button" className="button button-primary button-wide" disabled={busy} onClick={() => void submit()}>
        {busy ? "Checking its models…" : replaces ? "Replace it" : "Add"}
      </button>
    </Section>
  );
}

/** Set a model's price: pick one of the listed models or type a name. */
function SetPrice({ models, onSet }: { models: string[]; onSet: () => void }) {
  const [form, setForm] = useState({ model: "", input: "", output: "" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const built = priceBody(form);
    if ("error" in built) return setError(built.error);
    setBusy(true);
    setError(undefined);
    const r = await hubPost<Price>("prices", built.body);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setForm({ model: "", input: "", output: "" });
    onSet();
  };
  return (
    <div className="price-form">
      <input className="input mono small" list="price-models" placeholder="Model, e.g. openai/gpt-5" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
      <datalist id="price-models">
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <input className="input small" inputMode="decimal" placeholder="$ in" value={form.input} onChange={(e) => setForm({ ...form, input: e.target.value })} />
      <input className="input small" inputMode="decimal" placeholder="$ out" value={form.output} onChange={(e) => setForm({ ...form, output: e.target.value })} />
      <button type="button" className="button button-plain" disabled={busy} onClick={() => void submit()}>
        Set price
      </button>
      {error && <Banner tone="bad">{error}</Banner>}
    </div>
  );
}
