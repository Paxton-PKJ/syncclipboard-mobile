package expo.modules.nativeutil

/** 将摘要字节编码为小写十六进制字符串，供文件哈希计算与拖拽内容校验共用。 */
internal fun ByteArray.toLowerHex(): String = joinToString("") { "%02x".format(it) }
