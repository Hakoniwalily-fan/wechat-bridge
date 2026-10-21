export function chunkText(text, limit = 2000) {
  if (!Number.isFinite(limit) || limit < 1) limit = 2000;
  const s = String(text ?? '');
  if (!s) return [];

  const out = [];
  let rest = s;
  // 纯空白片段不能单独成片：手机上就是一条空消息。但空白也是内容，
  // 不能直接扔——先攒进 carry，拼到下一片真实内容前面；拼出来超过上限再从尾部切。
  let carry = '';

  const push = (piece) => {
    let head = carry + piece;
    carry = '';
    while (head.length > limit) {
      out.push(head.slice(0, limit));
      head = head.slice(limit);
    }
    if (head.trim()) out.push(head);
    else carry = head;
  };

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    let skip = 2;
    if (cut <= 0) {
      cut = window.lastIndexOf('\n');
      skip = 1;
    }
    if (cut <= 0) {
      cut = window.lastIndexOf(' ');
      skip = 1;
    }
    if (cut <= 0) {
      cut = limit;
      skip = 0;
    }
    push(rest.slice(0, cut));
    rest = rest.slice(cut + skip);
  }
  if ((carry + rest).trim()) push(rest);
  return out;
}
