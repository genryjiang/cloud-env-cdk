# install java
FROM eclipse-temurin:8-jdk-jammy AS jdk
# Required base OS
FROM ubuntu:22.04
# syntax=docker/dockerfile:1

# LABEL about the custom image
LABEL version="0.1.1"
LABEL description="Sunswift EMBD (High Level) Containerised Development Environment"

# Disable Prompt During Packages Installation
ARG DEBIAN_FRONTEND=noninteractive

# Set locale
RUN apt-get clean && apt update && apt install -y locales software-properties-common
RUN locale-gen en_US en_US.UTF-8
ENV LC_ALL en_US.UTF-8
ENV LANG en_US.UTF-8
ENV LANGUAGE en_US.UTF-8

# Copy JDK onto ubuntu image
# Copy the JDK into the Ubuntu image
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="$JAVA_HOME/bin:$PATH"


# Add ROS2 apt repository (this is needed for some fuckass reason idk why - DO NOT DELETE)
RUN apt update && apt install -y curl gnupg2 lsb-release && \
	curl -s https://raw.githubusercontent.com/ros/rosdistro/master/ros.asc | apt-key add - && \
	sh -c 'echo "deb [arch=$(dpkg --print-architecture)] http://packages.ros.org/ros2/ubuntu $(lsb_release -cs) main" > /etc/apt/sources.list.d/ros2-latest.list'

# Build tools needed for building dependencies
RUN apt update && apt install -y \
	build-essential \
  	git \
  	libbullet-dev \
  	python3-colcon-common-extensions \
  	python3-flake8 \
	python3-pip \
	python3-pytest-cov \
	python3-rosdep \
	python3-setuptools \
	python3-vcstool \
	wget \
	bc \
	subversion \
	autoconf \
	libtool-bin \
	libssl-dev \
	zlib1g-dev \
	rename \
	rsync \
	xsltproc \
	libtool \
	automake \
	pkg-config \
	gfortran \
	vim \
	dos2unix \
	sassc \
	libglib2.0-bin \
	libglib2.0-dev \
	ninja-build \
	net-tools \
	tree

# Install python 3.11
RUN add-apt-repository ppa:deadsnakes/ppa -y && \
	apt update && \
	apt-get install -y \
	python3.11-dev \
	python3.11-venv \
	python3.11-distutils \
	rename

# Install CMake 3.22
RUN cd /opt && sudo wget https://cmake.org/files/v3.22/cmake-3.22.0-linux-x86_64.sh && \
	sudo mkdir /opt/cmake-3.22.0-linux-x86_64 && \
	yes | sudo sh cmake-3.22.0-linux-x86_64.sh --prefix=/opt/cmake-3.22.0-linux-x86_64 --skip-license && \
	sudo ln -s /opt/cmake-3.22.0-linux-x86_64/bin/cmake /usr/local/bin/cmake


# Install cpp check (need to get misra later, tentative to delete)
RUN apt-get update && apt-get install -y --no-install-recommends \
    cppcheck \
 && rm -rf /var/lib/apt/lists/*

# 

# Adding user
ARG USER_NAME
ARG GROUP_NAME
ARG USER_ID
ARG GROUP_ID
ARG QNX_SDP_VERSION

ENV QNX_SDP_VERSION=$QNX_SDP_VERSION

ENV PS1='[QNX] (\u) \w$ '

RUN getent group ${GROUP_NAME} || groupadd --gid ${GROUP_ID} ${GROUP_NAME} && \
	useradd --uid ${USER_ID} --gid ${GROUP_ID} --groups sudo --no-log-init --create-home ${USER_NAME} && \
	echo "${USER_NAME}:password" | chpasswd

# Create a folder for python venv
RUN mkdir -p /usr/local/qnx
RUN chown ${USER_NAME} /usr/local/qnx
USER ${USER_NAME}

# Install standard development tools
# Install pip packages needed for testing
# Needed to build numpy from source
RUN cd /usr/local/qnx && \
	python3.11 -m venv env && \
	. ./env/bin/activate && \
	python3 -m pip install -U \
	pip \
	empy==3.3.4 \
	lark \
	Cython \
	wheel \
	colcon-common-extensions \
	vcstool \
	catkin_pkg \
	argcomplete \
	flake8-blind-except \
	flake8-builtins \
	flake8-class-newline \
	flake8-comprehensions \
	flake8-deprecated \
	flake8-docstrings \
	flake8-import-order \
	flake8-quotes \
	pytest-repeat \
	pytest-rerunfailures \
	pytest \
	pybind11 \
	requests

# Add QNX SDP + Additional (dev-can-linux (pre built), mosquitto, etc) --> Should be in QNX800 folder (upload once built)
COPY .qnx /home/${USER_NAME}/.qnx
COPY qnx800 /home/${USER_NAME}/qnx800

WORKDIR /workspace

RUN java -version && javac -version
RUN /bin/bash -c "echo 'source $HOME/qnx800/qnxsdp-env.sh' >> ~/.bashrc"
CMD ["/bin/bash", "-i"]
