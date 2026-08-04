function imageToScreen(point, viewport) {
  return {
    x: viewport.left + (point.x / viewport.imageWidth) * viewport.width,
    y: viewport.top + (point.y / viewport.imageHeight) * viewport.height,
  };
}

function screenToImage(point, viewport) {
  return {
    x: Math.round(((point.x - viewport.left) / viewport.width) * viewport.imageWidth),
    y: Math.round(((point.y - viewport.top) / viewport.height) * viewport.imageHeight),
  };
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
}

function validateCourtQuadrilateral(points, imageSize = {}) {
  if (!Array.isArray(points) || points.length !== 4) {
    return { valid: false, message: "请标记完整的四个球场角点" };
  }
  const width = Number(imageSize.width) || 0;
  const height = Number(imageSize.height) || 0;
  if (points.some((point) => !Array.isArray(point)
    || point.length !== 2
    || !point.every(Number.isFinite)
    || point[0] < 0 || point[1] < 0
    || (width && point[0] > width) || (height && point[1] > height))) {
    return { valid: false, message: "角点超出画面，请重新调整" };
  }
  if (width && height && polygonArea(points) < width * height * 0.001) {
    return { valid: false, message: "标记区域面积过小，请覆盖完整球场" };
  }
  const signs = points.map((point, index) => cross(
    point,
    points[(index + 1) % points.length],
    points[(index + 2) % points.length],
  ));
  if (signs.some((value) => Math.abs(value) < 1)
    || !(signs.every((value) => value > 0) || signs.every((value) => value < 0))) {
    return { valid: false, message: "角点顺序交叉或形状无效，请按顺时针重新标记" };
  }
  return { valid: true, message: "" };
}

module.exports = { imageToScreen, screenToImage, validateCourtQuadrilateral };
