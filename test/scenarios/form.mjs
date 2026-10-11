// Every common form control, filled the way an agent would: fill_form, select_option and type, then submit.
export default {
  name: 'form',
  async run(t) {
    const tab = await t.open(`${t.site}/form.html`);
    t.step('snapshot');
    const s = await t.snapshot(tab);

    t.step('fill_form');
    await t.call('fill_form', {
      tab, fields: [
        { ref: t.ref(s, 'textbox', 'Full name'), value: `Ada ${t.tag}` },
        { ref: t.ref(s, 'textbox', 'Email'), value: 'ada@example.com' },
        { ref: t.ref(s, 'spinbutton', 'Age'), value: '36' },
        { ref: t.ref(s, 'textbox', 'Bio'), value: 'Line one\nLine two' },
        { ref: t.ref(s, 'combobox', 'Country'), value: 'Japan' },
        { ref: t.ref(s, 'checkbox', 'Music'), value: 'true' },
        { ref: t.ref(s, 'checkbox', 'Code'), value: 'true' },
        { ref: t.ref(s, 'radio', 'Pro'), value: 'true' },
        { ref: t.ref(s, ['textbox', 'generic'], 'Start date'), value: '2026-11-01' },
        { ref: t.ref(s, 'slider', 'Volume'), value: '80' },
      ],
      snapshot: false,
    });

    t.step('select_option multi');
    await t.call('select_option', { tab, ref: t.ref(s, 'listbox', 'Languages'), values: ['English', 'Japanese'], snapshot: false });

    t.step('type contenteditable');
    await t.call('type', { tab, ref: t.ref(s, 'textbox', 'Notes editor'), text: 'Hello editor', snapshot: false });

    t.step('type controlled input');
    await t.call('type', { tab, ref: t.ref(s, 'textbox', 'Code (typed only)'), text: `C-${t.tag}`, snapshot: false });

    t.step('submit');
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Submit'), snapshot: false });

    t.step('assert submitted values');
    const r = await t.until(async () => { const v = await t.resultOf(tab); return typeof v === 'object' && v; }, 'form submitted');
    t.eq(r.name, `Ada ${t.tag}`, 'name');
    t.eq(r.email, 'ada@example.com', 'email');
    t.eq(r.age, '36', 'age');
    t.eq(r.bio, 'Line one\nLine two', 'bio');
    t.eq(r.country, 'jp', 'country');
    t.eq(r.languages, ['en', 'ja'], 'languages');
    t.eq(r.interests, ['music', 'code'], 'interests');
    t.eq(r.plan, 'pro', 'plan');
    t.eq(r.start, '2026-11-01', 'date');
    t.eq(r.volume, '80', 'range');
    t.eq(r.editor, 'Hello editor', 'contenteditable');
    t.eq(r.controlled, `C-${t.tag}`, 'controlled input');
  },
};
