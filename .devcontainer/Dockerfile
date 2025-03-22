FROM mcr.microsoft.com/devcontainers/python:3.13
USER vscode
# TODO: the version will not be updated by dependabot, but it's still a good idea to
# freeze the version.
RUN curl -LsSf https://astral.sh/uv/0.6.6/install.sh | sh
RUN echo 'eval "$(uv generate-shell-completion bash)"' >> ~/.bashrc
