// Router theo hash (#/upload, #/watch/<id>). CloudFront không trả index.html cho đường dẫn lạ,
// nên dùng hash để tải lại trang hay mở link trực tiếp vẫn chạy mà không phải sửa hạ tầng.
import { useEffect, useState } from 'react';

function parse() {
  const path = window.location.hash.replace(/^#/, '') || '/';
  const watch = path.match(/^\/watch\/([0-9a-f-]{36})$/i);
  if (watch) return { page: 'watch', id: watch[1] };
  if (path === '/upload') return { page: 'upload' };
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
};

export const navigate = (to) => {
  window.location.hash = to.replace(/^#/, '');
};
