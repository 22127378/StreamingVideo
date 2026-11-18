// Router theo hash (#/upload, #/watch/<id>, #/live, #/live/<channelId>, #/studio). CloudFront không trả index.html cho đường dẫn lạ,
// nên dùng hash để tải lại trang hay mở link trực tiếp vẫn chạy mà không phải sửa hạ tầng.
import { useEffect, useState } from 'react';

function parse() {
  const path = window.location.hash.replace(/^#/, '') || '/';
  const watch = path.match(/^\/watch\/([0-9a-f-]{36})$/i);
  if (watch) return { page: 'watch', id: watch[1] };
  if (path === '/upload') return { page: 'upload' };
  const channel = path.match(/^\/live\/([0-9a-f-]{36})$/i);
  if (channel) return { page: 'channel', id: channel[1] };
  if (path === '/live') return { page: 'live' };
  if (path === '/studio') return { page: 'studio' };
  return { page: 'home' };
}

export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => {
      setRoute(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const href = {
  home: '#/',
  upload: '#/upload',
  watch: (id) => `#/watch/${id}`,
  live: '#/live',
  channel: (id) => `#/live/${id}`,
  studio: '#/studio',
};

export const navigate = (to) => {
  window.location.hash = to.replace(/^#/, '');
};
