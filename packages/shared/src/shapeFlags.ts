export const enum ShapeFlags {
  // 元素
  ELEMENT = 1,
  FUNCTIONAL_COMPONENT = 1 << 1,
  // 有状态组件
  STATEFUL_COMPONENT = 1 << 2,
  // 文本
  TEXT_CHILDREN = 1 << 3,
  // 数组
  ARRAY_CHILDREN = 1 << 4,
  // 插槽
  SLOTS_CHILDREN = 1 << 5,
  // 远距离传送
  TELEPORT = 1 << 6,
  // 暂停状态
  SUSPENSE = 1 << 7,
  // 组件 应 保持活性
  COMPONENT_SHOULD_KEEP_ALIVE = 1 << 8,
  // 组件 保持活性
  COMPONENT_KEPT_ALIVE = 1 << 9,
  // 组件：即使状态组件，也是 函数组件
  COMPONENT = ShapeFlags.STATEFUL_COMPONENT | ShapeFlags.FUNCTIONAL_COMPONENT
}
