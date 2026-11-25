
    import './live.js';
    import('./park.js').catch(error => {
      console.error(error);
      document.getElementById('loading').textContent = '此设备暂时无法打开 3D 场景，仍可打开「轮次与待办」。';
    });
