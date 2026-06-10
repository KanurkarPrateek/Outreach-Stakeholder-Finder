import { findStakeholders } from '@/lib/serp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const company = (body?.company || '').toString().trim();
  if (!company) {
    return Response.json({ error: 'Provide a company name.' }, { status: 400 });
  }
  if (company.length > 120) {
    return Response.json({ error: 'Company name is too long.' }, { status: 400 });
  }

  const serperKey = (body?.serperKey || '').toString().trim() || undefined;

  const extraRoles = Array.isArray(body?.extraRoles)
    ? body.extraRoles.map((t) => String(t).slice(0, 60).trim()).filter(Boolean).slice(0, 12)
    : [];

  try {
    const data = await findStakeholders(company, serperKey, extraRoles);
    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: `Search failed: ${err?.message || 'unknown error'}` },
      { status: 502 }
    );
  }
}
