export function rememberLabelSizes(entries,sizes) {
  for(const entry of entries) {
    const width=entry.borderBoxSize?.[0]?.inlineSize??entry.contentRect.width;
    const height=entry.borderBoxSize?.[0]?.blockSize??entry.contentRect.height;
    // Display:none reports zero; forgetting the visible bounds would make collision hiding oscillate.
    if(width>0&&height>0)sizes.set(entry.target,[width,height]);
  }
}
