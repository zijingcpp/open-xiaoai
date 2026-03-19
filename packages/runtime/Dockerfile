# syntax=docker/dockerfile:1.4
FROM ubuntu:20.04

# 1. 环境变量合并，减少层数
ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/opt/toolchain/bin:/root/.cargo/bin:${PATH}" \
    PKG_CONFIG_ALLOW_CROSS=1 \
    PKG_CONFIG_SYSROOT_DIR=/opt/sysroot \
    PKG_CONFIG_LIBDIR=/opt/sysroot/usr/lib/pkgconfig:/opt/sysroot/lib/pkgconfig \
    CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_LINKER=arm-linux-gnueabihf-gcc \
    CC_armv7_unknown_linux_gnueabihf="arm-linux-gnueabihf-gcc --sysroot=/opt/sysroot"

# 2. 基础依赖与多架构源配置合并
# 使用 --mount=type=cache 优化 apt 操作
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    sed -i 's/archive.ubuntu.com/mirrors.aliyun.com/g' /etc/apt/sources.list && \
    sed -i 's/security.ubuntu.com/mirrors.aliyun.com/g' /etc/apt/sources.list && \
    sed -i 's/deb http/deb [arch=amd64] http/g' /etc/apt/sources.list && \
    echo "deb [arch=armhf] http://mirrors.aliyun.com/ubuntu-ports/ focal main restricted universe multiverse" > /etc/apt/sources.list.d/armhf.list && \
    echo "deb [arch=armhf] http://mirrors.aliyun.com/ubuntu-ports/ focal-updates main restricted universe multiverse" >> /etc/apt/sources.list.d/armhf.list && \
    dpkg --add-architecture armhf && \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential qemu-user-static pkg-config libssl-dev xz-utils squashfs-tools \
    crossbuild-essential-armhf libasound2-dev:armhf libopus-dev:armhf libssl-dev:armhf && \
    # 删除 lists 文件以减小体积
    rm -rf /var/lib/apt/lists/*

# 3. 安装 Linaro Toolchain & Rust
# 使用本地工具链文件，减少网络依赖
COPY gcc-linaro-7.5.0-2019.12-x86_64_arm-linux-gnueabihf.tar /tmp/gcc-linaro.tar
RUN mkdir -p /opt/toolchain && \
    tar -xf /tmp/gcc-linaro.tar -C /opt/toolchain --strip-components=1 && \
    rm /tmp/gcc-linaro.tar && \
    RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup \
    RUSTUP_UPDATE_ROOT=https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup \
    curl --proto '=https' --tlsv1.2 -sSf https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup-init.sh | sh -s -- -y --default-toolchain stable && \
    echo '[source.crates-io]' > /root/.cargo/config.toml && \
    echo 'replace-with = "tuna"' >> /root/.cargo/config.toml && \
    echo '[source.tuna]' >> /root/.cargo/config.toml && \
    echo 'registry = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"' >> /root/.cargo/config.toml && \
    RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup rustup target add armv7-unknown-linux-gnueabihf

WORKDIR /app

# 4. 脚本与 Rootfs 处理
# 使用 --mount=bind 减少一次 COPY 导致的镜像体积增加
COPY run.sh runtime.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/run.sh /usr/local/bin/runtime.sh

# 处理 root.squashfs：利用临时挂载或直接解压并删除
RUN --mount=type=bind,source=root.squashfs,target=/app/root.squashfs \
    mkdir -p /opt/sysroot && unsquashfs -d /opt/sysroot -f /app/root.squashfs

# 5. 构建混合 Sysroot 逻辑优化
# 将所有文件操作合并到一个 RUN 块，减少 Metadata 冗余
RUN set -e; \
    # 1. 自动为共享库创建 .so 软链接
    find /opt/sysroot/lib /opt/sysroot/usr/lib -name "lib*.so.*" | while read -r src; do \
        link_name=$(echo "$src" | sed 's/\.so\..*$/.so/'); \
        if [ ! -e "$link_name" ]; then \
            ln -s "$(basename "$src")" "$link_name"; \
        fi; \
    done; \
    # 2. 拷贝 crt*.o 文件
    find /opt/toolchain/arm-linux-gnueabihf/libc -name "*crt*.o" -exec cp {} /opt/sysroot/usr/lib/ \; ; \
    # 3. 拷贝 libc_nonshared.a
    cp /opt/toolchain/arm-linux-gnueabihf/libc/usr/lib/libc_nonshared.a /opt/sysroot/usr/lib/; \
    if [ -f /opt/toolchain/arm-linux-gnueabihf/libc/usr/lib/libpthread_nonshared.a ]; then \
        cp /opt/toolchain/arm-linux-gnueabihf/libc/usr/lib/libpthread_nonshared.a /opt/sysroot/usr/lib/; \
    fi; \
    # 4. 生成 Linker Scripts
    printf "OUTPUT_FORMAT(elf32-littlearm)\nGROUP ( /lib/libc.so.6 /usr/lib/libc_nonshared.a AS_NEEDED ( /lib/ld-linux-armhf.so.3 ) )\n" > /opt/sysroot/usr/lib/libc.so; \
    if [ -f /opt/sysroot/lib/libpthread.so.0 ]; then \
        printf "OUTPUT_FORMAT(elf32-littlearm)\nGROUP ( /lib/libpthread.so.0 /usr/lib/libpthread_nonshared.a )\n" > /opt/sysroot/usr/lib/libpthread.so; \
    fi; \
    # 5. 注入头文件和 pkgconfig
    cp -r /usr/include/alsa /opt/sysroot/usr/include/ 2>/dev/null || true; \
    cp -r /usr/include/opus /opt/sysroot/usr/include/ 2>/dev/null || true; \
    if [ -d /usr/include/arm-linux-gnueabihf ]; then \
        cp -r /usr/include/arm-linux-gnueabihf/* /opt/sysroot/usr/include/ 2>/dev/null || true; \
    fi; \
    if [ -d /usr/lib/arm-linux-gnueabihf/pkgconfig ]; then \
        cp -r /usr/lib/arm-linux-gnueabihf/pkgconfig/* /opt/sysroot/usr/lib/pkgconfig/ 2>/dev/null || true; \
    fi

# 6. 设置 Rust 链接参数
ENV CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_RUSTFLAGS="\
    -C link-arg=--sysroot=/opt/sysroot \
    -C link-arg=-Wl,-dynamic-linker,/lib/ld-linux-armhf.so.3 \
    -C link-arg=-L/opt/sysroot/usr/lib \
    -C link-arg=-L/opt/sysroot/lib \
    -C link-arg=-Wl,-rpath-link,/opt/sysroot/usr/lib \
    -C link-arg=-Wl,-rpath-link,/opt/sysroot/lib"

CMD ["/bin/bash"]