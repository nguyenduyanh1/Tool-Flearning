// Gửi form submission sang HubSpot. Endpoint public này chỉ nhận dữ liệu của một form
// đã có sẵn; không chứa token hay quyền đọc/sửa dữ liệu CRM.

const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || "3797615";
const FORM_ID = process.env.HUBSPOT_FORM_GUID || "e5613d7e-6fd0-46d8-83ff-0d25fe131aea";
export async function submitHubSpotLead(email: string, hutk: string): Promise<boolean> {
  try {
    const r = await fetch(`https://api.hsforms.com/submissions/v3/integration/submit/${PORTAL_ID}/${FORM_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        submittedAt: Date.now(),
        fields: [{ name: "email", value: email }],
        context: {
          pageUri: "https://tool-flearning.web.app/brandkit/",
          pageName: "F.Learning Brand Kit",
          ...(hutk ? { hutk } : {}),
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) console.error("HubSpot form submission lỗi", r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) {
    console.error("HubSpot form submission lỗi", e);
    return false;
  }
}
