#!/bin/bash
# This script sets environment variables required to use this version of QNX Software Development Platform
# from the command line. To use the script, you have to "source" it into your shell, i.e.:
#   source qnxsdp-env-zsh.sh
# if source command is not available use "." (dot) command instead
#
if [ -n "$BASH_VERSION" ]; then
  SCRIPT_SOURCE=${BASH_SOURCE[0]}
elif [ -n "$ZSH_VERSION" ]; then
  SCRIPT_SOURCE=$(eval 'printf "%s" "${(%):-%N}"')
else
  echo "This script can be sourced only from bash or zsh"
  return 1 2>/dev/null || exit 1
fi

test "$SCRIPT_SOURCE" = "$0" && echo "Script is being run, should be sourced" && exit 1

HOST_OS=$(uname -s)
QNX_BASE=/home/henryjiang/qnx800
case "$HOST_OS" in
  Linux)
    QNX_HOST=$QNX_BASE/host/linux/x86_64
    ;;
  *)
    QNX_HOST=$QNX_BASE/host/win64/x86_64
    ;;
esac

QNX_TARGET=$QNX_BASE/target/qnx
QNX_CONFIGURATION_EXCLUSIVE=$HOME/.qnx
QNX_CONFIGURATION=$QNX_CONFIGURATION_EXCLUSIVE

MAKEFLAGS=-I$QNX_BASE/target/qnx/usr/include
PATH=$QNX_HOST/usr/bin:$QNX_CONFIGURATION/bin:$QNX_BASE/jre/bin:$QNX_BASE/host/common/bin:$PATH

#This is set to make sdp installation read-only (otherwise python will create extra files when you run debuger)
#If you using python for something else and need it, comment out this line
PYTHONDONTWRITEBYTECODE=1
#This is unset to prevent using python distribution which is not shipped with sdp
unset PYTHONPATH

export QNX_TARGET QNX_HOST QNX_CONFIGURATION QNX_CONFIGURATION_EXCLUSIVE MAKEFLAGS PATH PYTHONDONTWRITEBYTECODE

if [ -f "${SCRIPT_DIR}/license-env.sh" ]; then
  . "${SCRIPT_DIR}/license-env.sh"
fi

echo QNX_HOST=$QNX_HOST
echo QNX_TARGET=$QNX_TARGET
echo MAKEFLAGS=$MAKEFLAGS

#Do not edit past this line
