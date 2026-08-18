/**
 * The clipboard API is missing on insecure origins and refused outside a user
 * gesture on some browsers, so a hidden field carries the copy where it is not
 * available. The caller is told when neither route worked.
 */
export async function copyLink(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const field = document.createElement('textarea');
    field.value = url;
    field.readOnly = true;
    Object.assign(field.style, { position: 'fixed', opacity: '0' });
    document.body.append(field);
    try {
      field.select();
      if (!document.execCommand('copy'))
        throw new Error('Copy the link from the field.');
    } finally {
      field.remove();
    }
  }
}
