const files = process.argv.slice(2).filter(Boolean)
if (files.length) {
  console.log(`检测到文件变更（可能为新增/修改/删除），已触发热更新：${files.join(', ')}`)
} else {
  console.log('检测到文件变更（可能为新增/修改/删除），已触发热更新。')
}
