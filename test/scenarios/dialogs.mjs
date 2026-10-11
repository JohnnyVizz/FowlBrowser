// alert, confirm and prompt: the action reports the open dialog, the dialog tool answers it.
export default {
  name: 'dialogs',
  async run(t) {
    const tab = await t.open(`${t.site}/dialogs.html`);
    const s = await t.snapshot(tab);
    const result = () => t.resultOf(tab);

    t.step('alert');
    const clicked = await t.call('click', { tab, ref: t.ref(s, 'button', 'Show alert'), snapshot: false });
    t.ok(/alert/i.test(clicked.text) && /Hello from alert/.test(clicked.text), `click result should report the alert: ${clicked.text.slice(0, 300)}`);
    await t.call('dialog', { tab, accept: true });
    await t.until(async () => (await result()) === 'alert:closed', 'alert closed');

    t.step('confirm dismissed');
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Show confirm'), snapshot: false });
    await t.call('dialog', { tab, accept: false });
    await t.until(async () => (await result()) === 'confirm:false', 'confirm returned false');

    t.step('confirm accepted');
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Show confirm'), snapshot: false });
    await t.call('dialog', { tab, accept: true });
    await t.until(async () => (await result()) === 'confirm:true', 'confirm returned true');

    t.step('prompt');
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Show prompt'), snapshot: false });
    await t.call('dialog', { tab, accept: true, text: `Ada ${t.tag}` });
    await t.until(async () => (await result()) === `prompt:Ada ${t.tag}`, 'prompt returned typed text');

    t.step('dialog during fill_form: the rest of the fill finishes before the next tool');
    const fields = [['First', 'one'], ['Second', 'two'], ['Third', 'from form']].map(([name, value]) => ({ ref: t.ref(s, 'textbox', name), value }));
    const filled = await t.call('fill_form', { tab, fields, snapshot: false });
    t.ok(/Keep filling\?/.test(filled.text), `fill_form should report the confirm: ${filled.text.slice(0, 300)}`);
    await t.call('dialog', { tab, accept: true, snapshot: false });
    await t.call('type', { tab, ref: t.ref(s, 'textbox', 'Third'), text: 'from agent', snapshot: false });
    t.eq(await t.eval(tab, `() => ['first', 'second', 'third'].map(id => document.getElementById(id).value)`), ['one', 'two', 'from agent'], 'fields after the dialog');
  },
};
